package com.westshoredrone.watch

import android.content.Context
import android.os.Handler
import android.os.SystemClock
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

// Drives POSTs to /api/nodes/<deviceId>/detections from inside the native
// foreground service so uploads continue when the JS runtime is suspended in
// Doze. See BLEScannerService for how detections are fed in.
class DetectionUploader(private val handler: Handler, private val context: Context) {

    // deviceId -> (uasId -> latest DroneRecord).
    // Coalesces repeat sightings within a flush window into the most recent
    // reading per drone, same semantics as detectionUploader.ts.
    private val queue = ConcurrentHashMap<String, ConcurrentHashMap<String, DroneRecord>>()

    @Volatile private var baseUrl: String? = null
    @Volatile private var authToken: String? = null

    // Billing-pause backoff. On 402 (deployment paused) we re-enqueue the
    // batch and skip flushes until pausedUntilElapsedMs. Backoff doubles on
    // each consecutive 402 (5s → 10s → … → 60s cap) so we don't hammer the
    // backend during a long pause window. Resets to 0 on the next 2xx.
    @Volatile private var pausedBackoffMs: Long = 0L
    @Volatile private var pausedUntilElapsedMs: Long = 0L

    private val loggedMissingNodes = java.util.Collections.newSetFromMap(
        ConcurrentHashMap<String, Boolean>()
    )
    // Per-flush cycle gate so the cap warning fires at most once per tick.
    private val capWarnedThisCycle = AtomicBoolean(false)

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private val flushRunnable = object : Runnable {
        override fun run() {
            try {
                flushOnce()
            } catch (t: Throwable) {
                Log.w(TAG, "flush error: ${t.message}")
            } finally {
                handler.postDelayed(this, FLUSH_INTERVAL_MS)
            }
        }
    }

    data class DroneRecord(
        val id: String,
        val lat: Double,
        val lon: Double,
        val alt: Double?,
        val spd: Double?,
        val hdg: Double?,
        val opLat: Double?,
        val opLon: Double?,
    )

    fun configure(baseUrl: String?, authToken: String?) {
        this.baseUrl = baseUrl?.trimEnd('/')
        this.authToken = authToken?.takeIf { it.isNotBlank() }
        Log.d(
            TAG,
            "configure: baseUrl=${this.baseUrl} authToken=${if (this.authToken != null) "<set>" else "<null>"}"
        )
    }

    fun start() {
        handler.removeCallbacks(flushRunnable)
        handler.postDelayed(flushRunnable, FLUSH_INTERVAL_MS)
    }

    fun stop() {
        handler.removeCallbacks(flushRunnable)
    }

    fun enqueue(deviceId: String, record: DroneRecord) {
        val bucket = queue.getOrPut(deviceId) { ConcurrentHashMap() }
        if (bucket.size >= MAX_PER_NODE && !bucket.containsKey(record.id)) {
            if (capWarnedThisCycle.compareAndSet(false, true)) {
                Log.w(TAG, "buffer cap ($MAX_PER_NODE) hit for node=$deviceId, dropping new uasIds until flush")
            }
            return
        }
        bucket[record.id] = record
    }

    // Best-effort synchronous flush. Used on ACTION_STOP.
    fun flushBlocking(timeoutMs: Long) {
        val latch = CountDownLatch(1)
        handler.post {
            try {
                flushOnce()
            } catch (t: Throwable) {
                Log.w(TAG, "flushBlocking error: ${t.message}")
            } finally {
                latch.countDown()
            }
        }
        try {
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun flushOnce() {
        capWarnedThisCycle.set(false)
        if (queue.isEmpty()) return

        // Honour billing-pause backoff. Returning early keeps drones in the
        // queue (we haven't drained yet), so they'll go up on the next
        // un-paused tick.
        if (SystemClock.elapsedRealtime() < pausedUntilElapsedMs) return

        val url = baseUrl
        val token = authToken
        if (url == null) return
        if (token == null) {
            // Hold the buffer; a configure() with a real token will re-enable
            // uploads without losing what we've already seen.
            return
        }

        val snapshot = mutableListOf<Pair<String, List<DroneRecord>>>()
        val iter = queue.entries.iterator()
        while (iter.hasNext()) {
            val e = iter.next()
            val drones = e.value.values.toList()
            iter.remove()
            if (drones.isNotEmpty()) snapshot += e.key to drones
        }
        if (snapshot.isEmpty()) return

        for ((deviceId, drones) in snapshot) {
            postBatch(url, token, deviceId, drones)
        }
    }

    private fun postBatch(baseUrl: String, token: String, deviceId: String, drones: List<DroneRecord>) {
        val dronesJson = JSONArray()
        for (d in drones) {
            val o = JSONObject()
            o.put("id", d.id)
            o.put("lat", d.lat)
            o.put("lon", d.lon)
            o.put("alt", d.alt ?: JSONObject.NULL)
            o.put("spd", d.spd ?: JSONObject.NULL)
            o.put("hdg", d.hdg ?: JSONObject.NULL)
            o.put("op_lat", d.opLat ?: JSONObject.NULL)
            o.put("op_lon", d.opLon ?: JSONObject.NULL)
            dronesJson.put(o)
        }
        val bodyJson = JSONObject().put("drones", dronesJson).toString()
        val body = bodyJson.toRequestBody(JSON_MEDIA)

        val url = "$baseUrl/api/nodes/$deviceId/detections"
        val req = Request.Builder()
            .url(url)
            .post(body)
            .header("Authorization", "Bearer $token")
            .header("Content-Type", "application/json")
            .build()

        try {
            client.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) {
                    Log.i(TAG, "POST ok node=$deviceId drones=${drones.size} status=${resp.code}")
                    // Coming back from a billing pause? Tell JS to drop the
                    // banner and clear backoff so the next flush is immediate.
                    if (pausedBackoffMs > 0L) {
                        pausedBackoffMs = 0L
                        pausedUntilElapsedMs = 0L
                        emitEvent("DeploymentResumed", Arguments.createMap())
                    }
                } else if (resp.code == 404) {
                    val firstTime = loggedMissingNodes.add(deviceId)
                    if (firstTime) {
                        Log.w(TAG, "POST 404 node=$deviceId (not in org), dropping future uploads for this node this session")
                    }
                } else if (resp.code == 401) {
                    Log.w(TAG, "POST 401 node=$deviceId — auth token rejected, clearing so JS can re-configure")
                    authToken = null
                } else if (resp.code == 402) {
                    // Deployment paused (billing). Re-enqueue this batch so
                    // detections aren't lost during the pause window, bump
                    // backoff, and notify JS to show the banner.
                    val bodyStr = try { resp.body?.string() ?: "" } catch (_: Throwable) { "" }
                    var deploymentId: String? = null
                    if (bodyStr.isNotEmpty()) {
                        try {
                            val obj = JSONObject(bodyStr)
                            deploymentId = obj.optString("deployment_id", "").takeIf { it.isNotEmpty() }
                        } catch (_: Throwable) {}
                    }
                    Log.w(TAG, "POST 402 node=$deviceId — deployment paused, re-enqueueing batch (backoff=${pausedBackoffMs}ms→…)")
                    val bucket = queue.getOrPut(deviceId) { ConcurrentHashMap() }
                    for (d in drones) {
                        if (bucket.size >= MAX_PER_NODE && !bucket.containsKey(d.id)) break
                        bucket.putIfAbsent(d.id, d)
                    }
                    pausedBackoffMs =
                        if (pausedBackoffMs == 0L) PAUSED_BACKOFF_INITIAL_MS
                        else minOf(pausedBackoffMs * 2, PAUSED_BACKOFF_CAP_MS)
                    pausedUntilElapsedMs = SystemClock.elapsedRealtime() + pausedBackoffMs
                    val payload: WritableMap = Arguments.createMap().apply {
                        if (deploymentId != null) putString("deployment_id", deploymentId)
                    }
                    emitEvent("DeploymentPaused", payload)
                } else {
                    Log.w(TAG, "POST fail node=$deviceId status=${resp.code}")
                }
                Unit
            }
        } catch (e: IOException) {
            Log.w(TAG, "POST io error node=$deviceId: ${e.message} — requeueing")
            val bucket = queue.getOrPut(deviceId) { ConcurrentHashMap() }
            // Requeue (oldest discarded implicitly by cap check on next enqueue).
            for (d in drones) {
                if (bucket.size >= MAX_PER_NODE && !bucket.containsKey(d.id)) break
                bucket.putIfAbsent(d.id, d)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "POST error node=$deviceId: ${t.message}")
        }
    }

    private fun emitEvent(name: String, payload: WritableMap) {
        val app = context.applicationContext as? ReactApplication ?: return
        val reactContext: ReactContext? =
            app.reactNativeHost.reactInstanceManager.currentReactContext
        if (reactContext == null || !reactContext.hasActiveReactInstance()) return
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, payload)
        } catch (t: Throwable) {
            Log.w(TAG, "emitEvent failed: ${t.message}")
        }
    }

    companion object {
        private const val TAG = "DetectionUploader"
        // 500ms flush — tuned for perceived Live Map responsiveness. Backend
        // coalescer at 3s handles duplicate POSTs cleanly, so the higher POST
        // frequency doesn't translate into more WS broadcast churn.
        private const val FLUSH_INTERVAL_MS = 500L
        private const val MAX_PER_NODE = 200
        private const val PAUSED_BACKOFF_INITIAL_MS = 5_000L
        private const val PAUSED_BACKOFF_CAP_MS = 60_000L
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}

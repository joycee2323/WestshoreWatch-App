package com.westshoredrone.watch

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

// Native port of LiveMapScreen.tsx's per-node heartbeat. Lives in the FG
// service so heartbeats survive Android Doze (the JS setInterval used to be
// suspended when the screen was off, causing nodes to flip "offline" on the
// dashboard ~2 min after lock even while the native DetectionUploader kept
// uploading drone hits fine).
//
// Wired up in BLEScannerService alongside DetectionUploader. Whenever a
// Westshore-OUI BLE advertisement arrives in the scan callback, the service
// calls markNodeSeen(deviceId); every 30s this class POSTs a heartbeat for
// each node seen within the last 60s.
class NodeHeartbeatUploader(
    private val handler: Handler,
    private val ctx: Context,
) {

    // deviceId -> elapsed-realtime ms when most recent BLE was observed.
    private val lastSeen = ConcurrentHashMap<String, Long>()
    // deviceId -> latest firmware tag from the node's 0x08FE identity advert.
    private val firmwareByDevice = ConcurrentHashMap<String, OdidParser.FirmwareTag>()

    // deviceId -> true once a 404 has been logged. Mirrors the JS
    // loggedMissingHeartbeatNodes Set so we don't spam logs per cycle.
    private val loggedMissingNodes = java.util.Collections.newSetFromMap(
        ConcurrentHashMap<String, Boolean>()
    )

    // deviceId -> true while currently in the "stale, skipping" state. Used
    // so the skip log fires once per fresh→stale transition rather than every
    // 30s tick.
    private val currentlySkipping = java.util.Collections.newSetFromMap(
        ConcurrentHashMap<String, Boolean>()
    )

    @Volatile private var baseUrl: String? = null
    @Volatile private var authToken: String? = null

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
        Log.d(TAG, "start: heartbeat loop scheduled every ${FLUSH_INTERVAL_MS}ms")
    }

    fun stop() {
        handler.removeCallbacks(flushRunnable)
        Log.d(TAG, "stop: heartbeat loop cancelled")
    }

    fun markNodeFirmware(deviceId: String, tag: OdidParser.FirmwareTag) {
        firmwareByDevice[deviceId] = tag
    }

    fun markNodeSeen(deviceId: String) {
        if (deviceId.isBlank()) return
        lastSeen[deviceId] = SystemClock.elapsedRealtime()
    }

    private fun flushOnce() {
        val now = SystemClock.elapsedRealtime()

        // Forget anything older than FORGET_MS so the map doesn't grow
        // unboundedly across a long session of nodes coming in and out of
        // range.
        val iter = lastSeen.entries.iterator()
        while (iter.hasNext()) {
            val e = iter.next()
            if (now - e.value > FORGET_MS) {
                iter.remove()
                currentlySkipping.remove(e.key)
                Log.i(TAG, "forget ${e.key}: no BLE for 5+ min")
            }
        }

        if (lastSeen.isEmpty()) return
        val url = baseUrl ?: return
        val token = authToken ?: return  // Hold state; configure() will retry.

        // Read location once per cycle and reuse for every node POST. This
        // matches the spec — each heartbeat carries the phone's current best
        // position. getLastKnownLocation is non-blocking and good enough; we
        // don't need to force a fresh GPS fix every 30s.
        val loc = bestLastKnownLocation()

        for (e in lastSeen.entries) {
            val deviceId = e.key
            val idleMs = now - e.value
            if (idleMs > STALE_MS) {
                if (currentlySkipping.add(deviceId)) {
                    Log.i(TAG, "skip $deviceId: stale ${idleMs / 1000}s")
                }
                continue
            }
            currentlySkipping.remove(deviceId)
            postHeartbeat(url, token, deviceId, loc)
        }
    }

    private fun postHeartbeat(baseUrl: String, token: String, deviceId: String, loc: Location?) {
        val body = JSONObject().apply {
            put("connection_type", "ble_relay")
            // Stored as nodes.firmware_version (COALESCE: absent = unchanged).
            // firmware_build / relay_format are informational; the backend
            // ignores fields it does not know.
            firmwareByDevice[deviceId]?.let { fw ->
                put("firmware_version", fw.version)
                fw.build?.let { put("firmware_build", it) }
                fw.relayFormat?.let { put("relay_format", it) }
            }
            if (loc != null) {
                put("last_lat", loc.latitude)
                put("last_lon", loc.longitude)
            }
        }.toString().toRequestBody(JSON_MEDIA)

        val req = Request.Builder()
            .url("$baseUrl/api/nodes/$deviceId/heartbeat")
            .post(body)
            .header("Authorization", "Bearer $token")
            .header("Content-Type", "application/json")
            .build()

        try {
            client.newCall(req).execute().use { resp ->
                when {
                    resp.isSuccessful -> Log.i(TAG, "POST ok node=$deviceId status=${resp.code}")
                    resp.code == 404 -> {
                        if (loggedMissingNodes.add(deviceId)) {
                            Log.w(TAG, "POST 404 node=$deviceId (not in org), dropping future heartbeats for this node this session")
                        }
                        // Stop tracking it so we don't keep retrying.
                        lastSeen.remove(deviceId)
                    }
                    resp.code == 401 -> {
                        Log.w(TAG, "POST 401 node=$deviceId — auth token rejected, clearing so JS can re-configure")
                        authToken = null
                    }
                    else -> Log.w(TAG, "POST fail node=$deviceId status=${resp.code}")
                }
                Unit
            }
        } catch (e: IOException) {
            // Transient network failure — leave lastSeen alone so the next
            // cycle retries. Heartbeats are idempotent.
            Log.w(TAG, "POST io error node=$deviceId: ${e.message}")
        } catch (t: Throwable) {
            Log.w(TAG, "POST error node=$deviceId: ${t.message}")
        }
    }

    @SuppressLint("MissingPermission")
    private fun bestLastKnownLocation(): Location? {
        if (!hasLocationPermission()) return null
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        // Try in order of typical accuracy/freshness. "fused" is API 31+.
        val providers = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            providers += LocationManager.FUSED_PROVIDER
        }
        providers += listOf(
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            LocationManager.PASSIVE_PROVIDER,
        )
        var best: Location? = null
        for (p in providers) {
            val l = try {
                lm.getLastKnownLocation(p)
            } catch (_: Throwable) {
                null
            } ?: continue
            if (best == null || l.time > best.time) best = l
        }
        return best
    }

    private fun hasLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
    }

    companion object {
        private const val TAG = "NodeHeartbeatUploader"
        // Cadence + thresholds mirror the prior JS constants in
        // LiveMapScreen.tsx so behavior is identical post-port.
        private const val FLUSH_INTERVAL_MS = 30_000L
        private const val STALE_MS = 60_000L
        private const val FORGET_MS = 300_000L
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}

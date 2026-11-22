package com.westshoredrone.watch.auto

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.westshoredrone.watch.UploadConfig
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

enum class FeedStatus { IDLE, SIGNED_OUT, CONNECTING, CONNECTED, OFFLINE }

/**
 * Car-only connection to the backend live feed. Runs only while a car session
 * is started; the phone UI's own WebSocket (src/services/api.ts) is untouched.
 *
 * Mirrors the phone/watch clients: JWT in the handshake URL, SUBSCRIBE_ORG
 * (every detection the user's org can see, like the phone's passive Live Map
 * and the Wear app), re-sent until SUBSCRIBED_ORG is acked (the edge can drop
 * the first frame), 30 s app-layer PING, reconnect with 1→30 s backoff,
 * reconnect on SCOPE_CHANGED. On each connect it hydrates from
 * GET /api/detections/recent?minutes=1 so drones already in the air show at once.
 *
 * All listener callbacks are delivered on the main thread. Read-only: no writes
 * to the backend.
 */
class AutoFeed(
    context: Context,
    private val onObservations: (List<DroneObservation>) -> Unit,
    private val onStatus: (FeedStatus) -> Unit,
) {
    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // websocket: no read timeout
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    @Volatile private var running = false
    private var ws: WebSocket? = null
    private var generation = 0
    private var attempt = 0
    private var subscribeAcked = false
    private var subRetries = 0
    var status: FeedStatus = FeedStatus.IDLE
        private set

    fun start() {
        if (running) return
        running = true
        connect()
    }

    fun stop() {
        running = false
        generation++
        main.removeCallbacksAndMessages(null)
        ws?.let { runCatching { it.close(1000, "car session stopped") } }
        ws = null
        setStatus(FeedStatus.IDLE)
    }

    /** Final teardown when the car session is destroyed. */
    fun shutdown() {
        stop()
        io.shutdown()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    /** Called when a user asks to retry (e.g. after signing in on the phone). */
    fun retryNow() {
        if (!running) return
        if (status == FeedStatus.CONNECTED) return
        main.removeCallbacksAndMessages(null)
        attempt = 0
        connect()
    }

    private fun connect() {
        if (!running) return
        val gen = ++generation
        ws?.let { runCatching { it.cancel() } }
        ws = null
        if (status != FeedStatus.SIGNED_OUT) setStatus(FeedStatus.CONNECTING)
        io.execute {
            val token = AuthTokenProvider.currentToken(appContext)
            main.post {
                if (!running || gen != generation) return@post
                if (token == null) {
                    setStatus(FeedStatus.SIGNED_OUT)
                    schedule(SIGNED_OUT_RECHECK_MS) { connect() }
                } else {
                    hydrate(token, gen)
                    openSocket(token, gen)
                }
            }
        }
    }

    private fun hydrate(token: String, gen: Int) {
        val req = Request.Builder()
            .url("${apiBase()}/api/detections/recent?minutes=1")
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        client.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.w(TAG, "hydrate failed: ${e.message}")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { resp ->
                    if (resp.code == 401) {
                        main.post { if (gen == generation) onUnauthorized() }
                        return
                    }
                    if (!resp.isSuccessful) return
                    val body = resp.body?.string() ?: return
                    val obs = BackendParser.parseRestArray(body, System.currentTimeMillis())
                    main.post { if (running && gen == generation && obs.isNotEmpty()) onObservations(obs) }
                }
            }
        })
    }

    private fun openSocket(token: String, gen: Int) {
        val req = Request.Builder().url(wsUrl(token)).build()
        subscribeAcked = false
        subRetries = 0
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post {
                    if (gen != generation) return@post
                    attempt = 0
                    setStatus(FeedStatus.CONNECTED)
                    sendSubscribe(webSocket, gen)
                    schedulePing(webSocket, gen)
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val type = BackendParser.messageType(text)
                val now = System.currentTimeMillis()
                when (type) {
                    "DRONE_UPDATE" -> {
                        val obs = BackendParser.parseWsMessage(text, now)
                        main.post { if (running && gen == generation && obs.isNotEmpty()) onObservations(obs) }
                    }
                    "SUBSCRIBED_ORG" -> main.post { if (gen == generation) subscribeAcked = true }
                    "SCOPE_CHANGED" -> main.post { if (gen == generation) connect() }
                    else -> Unit
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                main.post { if (gen == generation) scheduleReconnect() }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val code = response?.code
                Log.w(TAG, "ws failure code=$code: ${t.message}")
                main.post {
                    if (gen != generation) return@post
                    if (code == 401) onUnauthorized() else scheduleReconnect()
                }
            }
        })
    }

    // Ack-gated subscribe, same as api.ts: resend every 2 s until acked, max 6 retries.
    private fun sendSubscribe(socket: WebSocket, gen: Int) {
        if (!running || gen != generation || subscribeAcked) return
        socket.send(SUBSCRIBE_ORG)
        if (subRetries++ < SUB_MAX_RETRIES) schedule(SUB_RETRY_MS) { sendSubscribe(socket, gen) }
    }

    private fun schedulePing(socket: WebSocket, gen: Int) {
        schedule(KEEPALIVE_MS) {
            if (!running || gen != generation) return@schedule
            socket.send(PING)
            schedulePing(socket, gen)
        }
    }

    private fun onUnauthorized() {
        // Expired/revoked token. The phone app routes the user to Login on its
        // next request; re-check periodically so the car recovers after sign-in.
        ws?.let { runCatching { it.cancel() } }
        ws = null
        setStatus(FeedStatus.SIGNED_OUT)
        schedule(SIGNED_OUT_RECHECK_MS) { connect() }
    }

    private fun scheduleReconnect() {
        if (!running) return
        ws = null
        setStatus(FeedStatus.OFFLINE)
        val delay = BACKOFF_MS[minOf(attempt, BACKOFF_MS.size - 1)]
        attempt++
        schedule(delay) { connect() }
    }

    private fun schedule(delayMs: Long, block: () -> Unit) {
        main.postAtTime({ if (running) block() }, SystemClock.uptimeMillis() + delayMs)
    }

    private fun setStatus(s: FeedStatus) {
        if (status == s) return
        status = s
        onStatus(s)
    }

    private fun apiBase(): String =
        (UploadConfig.baseUrl ?: DEFAULT_BASE).trimEnd('/').removeSuffix("/api")

    private fun wsUrl(token: String): String {
        val base = apiBase().replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
        return "$base/ws?token=${java.net.URLEncoder.encode(token, "UTF-8")}"
    }

    companion object {
        private const val TAG = "WswAutoFeed"
        private const val DEFAULT_BASE = "https://api.westshoredrone.com"
        private const val SUBSCRIBE_ORG = "{\"type\":\"SUBSCRIBE_ORG\"}"
        private const val PING = "{\"type\":\"PING\"}"
        private const val SUB_RETRY_MS = 2_000L
        private const val SUB_MAX_RETRIES = 6
        private const val KEEPALIVE_MS = 30_000L
        private const val SIGNED_OUT_RECHECK_MS = 10_000L
        private val BACKOFF_MS = longArrayOf(1_000, 2_000, 4_000, 8_000, 16_000, 30_000)
    }
}

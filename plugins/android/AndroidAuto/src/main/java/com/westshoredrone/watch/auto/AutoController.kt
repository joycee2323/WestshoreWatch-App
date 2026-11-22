package com.westshoredrone.watch.auto

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

/**
 * Per-car-session state: merges the backend feed and the local BLE tap into a
 * [DroneTracker], tracks the phone location, and tells screens when to redraw.
 * Everything runs on the main thread. Feeds run only while the session is
 * STARTED (car screen visible), so nothing runs when the car isn't connected.
 */
class AutoController(context: Context) : DefaultLifecycleObserver {
    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    val tracker = DroneTracker()
    val alerter = NewDroneAlerter()

    var feedStatus: FeedStatus = FeedStatus.IDLE
        private set
    /** True once the first hydrate or live frame arrived, or after a short grace period. */
    var hasInitialData = false
        private set

    private val listeners = LinkedHashSet<() -> Unit>()
    private var alertsArmed = false
    private var started = false

    private val feed = AutoFeed(
        context,
        onObservations = { obs -> ingest(obs) },
        onStatus = { s ->
            feedStatus = s
            if (s == FeedStatus.SIGNED_OUT) hasInitialData = true
            notifyChanged()
        },
    )
    private val location = PhoneLocation(context) { notifyChanged() }

    private val ticker = object : Runnable {
        override fun run() {
            val removed = tracker.evict(System.currentTimeMillis())
            // Redraw on eviction, and every tick while drones are listed so the
            // "seen N s ago" text stays current (screens throttle the redraws).
            if (removed.isNotEmpty() || tracker.size() > 0) notifyChanged()
            main.postDelayed(this, TICK_MS)
        }
    }

    private val initialGrace = Runnable {
        if (!hasInitialData) { hasInitialData = true; notifyChanged() }
    }

    /** Test seam: fixed origin for template tests (Robolectric has no location fix). */
    internal var originOverride: LatLon? = null

    val origin: LatLon?
        get() = originOverride ?: location.last?.let { LatLon(it.latitude, it.longitude) }

    fun hasLocationPermission(): Boolean = location.hasPermission()

    fun addListener(l: () -> Unit) { listeners += l }
    fun removeListener(l: () -> Unit) { listeners -= l }

    /** Screens call this once their first real (non-loading) list is on screen. */
    fun armAlerts() { alertsArmed = true }

    override fun onStart(owner: LifecycleOwner) {
        if (started) return
        started = true
        LocalDetectionTap.sink = { obs -> main.post { ingest(listOf(obs)) } }
        feed.start()
        location.start()
        main.postDelayed(ticker, TICK_MS)
        main.postDelayed(initialGrace, INITIAL_GRACE_MS)
        // Debug builds: fake-drone simulator (src/debug). Release: no-op (src/release).
        AutoDebugHooks.onSessionStarted(appContext, this)
    }

    override fun onStop(owner: LifecycleOwner) {
        if (!started) return
        started = false
        AutoDebugHooks.onSessionStopped(this)
        LocalDetectionTap.sink = null
        feed.stop()
        location.stop()
        main.removeCallbacks(ticker)
        main.removeCallbacks(initialGrace)
    }

    override fun onDestroy(owner: LifecycleOwner) {
        onStop(owner)
        feed.shutdown()
        listeners.clear()
    }

    /** After the user grants location on the phone. */
    fun onLocationPermissionChanged() {
        if (started) location.start()
        notifyChanged()
    }

    fun retryFeed() = feed.retryNow()

    /** Test seam: feed observations as if they came from the backend/local feeds. */
    internal fun ingestForTest(obs: List<DroneObservation>) = ingest(obs)

    private fun ingest(obs: List<DroneObservation>) {
        val now = System.currentTimeMillis()
        var changed = false
        for (o in obs) {
            val r = tracker.ingest(o, now)
            changed = changed || r.changed
            if (r.firstSightingThisSession && alertsArmed) {
                tracker.get(o.uasId)?.let { alerter.onNewDrone(it.displayName) }
            }
        }
        if (!hasInitialData) {
            hasInitialData = true
            changed = true
        }
        if (changed) notifyChanged()
    }

    private fun notifyChanged() {
        for (l in listeners.toList()) l()
    }

    companion object {
        private const val TICK_MS = 1_000L
        private const val INITIAL_GRACE_MS = 4_000L
    }
}

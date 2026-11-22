package com.westshoredrone.watch.auto

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log

/**
 * The phone's position, used as "your location" for distance/bearing (in
 * Android Auto the car app runs on the phone). Uses the platform fused provider
 * (API 31+, our minSdk), so no extra Play Services dependency.
 *
 * Location access with only foreground ("while in use") permission: Android
 * grants it while an activity is visible or a location-type foreground service
 * runs (our BLEScannerService is one, started from the phone UI). Whether a car
 * session alone counts is up to the platform/host; the Car App Library itself
 * requests fused updates from this process for the map's location dot, so it's
 * expected to work, but it's unverified on a device (android-auto-STATUS.md).
 * When access is withheld, nothing crashes: no fix → no distances.
 *
 * On start: a last-known fix is used only if it's at most [LAST_KNOWN_MAX_AGE_MS]
 * old (an hours-old fix from somewhere else would give confidently wrong
 * distances), plus one fresh getCurrentLocation request, plus periodic updates.
 */
class PhoneLocation(context: Context, private val onUpdate: (Location) -> Unit) {
    private val appContext = context.applicationContext
    private val lm = appContext.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
    private val main = Handler(Looper.getMainLooper())
    private var listening = false
    private var oneShot: CancellationSignal? = null
    var last: Location? = null
        private set

    private val listener = LocationListener { loc -> accept(loc) }

    private val noFixCheck = Runnable {
        if (listening && last == null) {
            Log.w(TAG, "no location fix ${NO_FIX_WARN_MS / 1000} s after start; location may be withheld while the phone app is in the background")
        }
    }

    /** Keeps the newest fix (the one-shot and periodic updates can arrive in any order). */
    private fun accept(loc: Location) {
        val cur = last
        if (cur != null && loc.elapsedRealtimeNanos < cur.elapsedRealtimeNanos) return
        last = loc
        onUpdate(loc)
    }

    fun hasPermission(): Boolean =
        appContext.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            appContext.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** Returns false when location permission hasn't been granted on the phone. */
    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        val mgr = lm ?: return false
        if (!hasPermission()) return false
        if (listening) return true
        try {
            val nowNanos = SystemClock.elapsedRealtimeNanos()
            bestLastKnown(mgr)
                ?.takeIf { LocationFreshness.isRecent(it.elapsedRealtimeNanos, nowNanos, LAST_KNOWN_MAX_AGE_MS) }
                ?.let { accept(it) }
            val provider = when {
                mgr.hasProvider(LocationManager.FUSED_PROVIDER) -> LocationManager.FUSED_PROVIDER
                mgr.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
                else -> LocationManager.NETWORK_PROVIDER
            }
            requestFreshFix(mgr, provider)
            mgr.requestLocationUpdates(provider, UPDATE_MS, UPDATE_MIN_M, listener, Looper.getMainLooper())
            listening = true
            main.removeCallbacks(noFixCheck)
            main.postDelayed(noFixCheck, NO_FIX_WARN_MS)
        } catch (t: Throwable) {
            Log.w(TAG, "location updates unavailable: ${t.message}")
        }
        return true
    }

    fun stop() {
        oneShot?.cancel()
        oneShot = null
        main.removeCallbacks(noFixCheck)
        if (!listening) return
        runCatching { lm?.removeUpdates(listener) }
        listening = false
    }

    /** One fresh fix now, so a stale or missing last-known fix is replaced quickly. */
    @SuppressLint("MissingPermission")
    private fun requestFreshFix(mgr: LocationManager, provider: String) {
        oneShot?.cancel()
        val signal = CancellationSignal()
        oneShot = signal
        runCatching {
            mgr.getCurrentLocation(provider, signal, appContext.mainExecutor) { loc ->
                if (oneShot === signal) oneShot = null
                if (loc != null) accept(loc)
            }
        }.onFailure { Log.w(TAG, "getCurrentLocation unavailable: ${it.message}") }
    }

    @SuppressLint("MissingPermission")
    private fun bestLastKnown(mgr: LocationManager): Location? =
        mgr.getProviders(true)
            .mapNotNull { runCatching { mgr.getLastKnownLocation(it) }.getOrNull() }
            .maxByOrNull { it.time }

    companion object {
        private const val TAG = "WswAutoLocation"
        private const val UPDATE_MS = 2_000L
        private const val UPDATE_MIN_M = 5f
        /** Older last-known fixes are ignored at start (wrong distances are worse than none). */
        const val LAST_KNOWN_MAX_AGE_MS = 5 * 60_000L
        private const val NO_FIX_WARN_MS = 15_000L
    }
}

/** Pure age check on elapsed-realtime clocks (immune to wall-clock changes). Unit-tested. */
object LocationFreshness {
    fun isRecent(fixElapsedNanos: Long, nowElapsedNanos: Long, maxAgeMs: Long): Boolean {
        val ageNanos = nowElapsedNanos - fixElapsedNanos
        return ageNanos >= 0 && ageNanos <= maxAgeMs * 1_000_000L
    }
}

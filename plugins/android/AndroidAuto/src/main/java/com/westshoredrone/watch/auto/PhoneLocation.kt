package com.westshoredrone.watch.auto

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import android.util.Log

/**
 * The phone's position, used as "your location" for distance/bearing (in
 * Android Auto the car app runs on the phone). Uses the platform fused provider
 * (API 31+, our minSdk), so no extra Play Services dependency. Falls back to
 * last-known fixes if live updates aren't available.
 */
class PhoneLocation(context: Context, private val onUpdate: (Location) -> Unit) {
    private val appContext = context.applicationContext
    private val lm = appContext.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
    private var listening = false
    var last: Location? = null
        private set

    private val listener = LocationListener { loc ->
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
            bestLastKnown(mgr)?.let { last = it; onUpdate(it) }
            val provider = when {
                mgr.hasProvider(LocationManager.FUSED_PROVIDER) -> LocationManager.FUSED_PROVIDER
                mgr.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
                else -> LocationManager.NETWORK_PROVIDER
            }
            mgr.requestLocationUpdates(provider, UPDATE_MS, UPDATE_MIN_M, listener, Looper.getMainLooper())
            listening = true
        } catch (t: Throwable) {
            Log.w(TAG, "location updates unavailable: ${t.message}")
        }
        return true
    }

    fun stop() {
        if (!listening) return
        runCatching { lm?.removeUpdates(listener) }
        listening = false
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
    }
}

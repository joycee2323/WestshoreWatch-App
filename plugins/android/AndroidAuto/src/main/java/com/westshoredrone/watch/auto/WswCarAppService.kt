package com.westshoredrone.watch.auto

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import androidx.car.app.CarAppService
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

/**
 * Android Auto entry point (category POI, declared in AndroidManifest.xml by
 * plugins/withAndroidAuto.js). Android Auto binds this service only while the
 * phone is projecting to a car / the Desktop Head Unit; when it isn't, none of
 * the car code runs.
 */
class WswCarAppService : CarAppService() {

    override fun createHostValidator(): HostValidator =
        CarHostValidators.forBuild(
            applicationContext,
            debuggable = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0,
        )

    override fun onCreateSession(): Session = DroneSession()
}

/**
 * Which Android Auto / AAOS hosts may bind the car service.
 *
 * Release: exactly what Google documents for production (CarAppService.createHostValidator
 * reference doc): hosts holding the TEMPLATE_RENDERER system permission (the default of
 * HostValidator.Builder) plus the library's `hosts_allowlist_sample`, which lists the
 * signing-certificate SHA-256 digests of Android Auto (com.google.android.projection.gearhead)
 * and the AAOS templates host. The validator matches against the host's whole signing
 * certificate history (SigningInfo.getSigningCertificateHistory), so a Google key ROTATION
 * keeps matching. The list ships with the library, so library upgrades carry any new
 * entries; CarHostValidatorsTest pins its current contents so a change is noticed.
 * See docs/android-auto-decisions.md (2026-11-22, task 3).
 *
 * Debug: any host (the DHU and test hosts), as the same doc advises.
 */
object CarHostValidators {
    fun forBuild(context: Context, debuggable: Boolean): HostValidator =
        if (debuggable) {
            HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
        } else {
            HostValidator.Builder(context)
                .addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)
                .build()
        }
}

class DroneSession : Session() {
    override fun onCreateScreen(intent: Intent): Screen {
        val controller = AutoController(carContext)
        lifecycle.addObserver(controller)
        return DroneListScreen(carContext, controller)
    }
}

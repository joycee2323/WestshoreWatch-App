package com.westshoredrone.watch.auto

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
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            // Debug builds: allow any host (DHU, test hosts).
            HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
        } else {
            // Release: only the Google-signed hosts the library ships (Android Auto,
            // Android Automotive templates host), plus any host holding the
            // TEMPLATE_RENDERER system permission.
            HostValidator.Builder(applicationContext)
                .addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)
                .build()
        }

    override fun onCreateSession(): Session = DroneSession()
}

class DroneSession : Session() {
    override fun onCreateScreen(intent: Intent): Screen {
        val controller = AutoController(carContext)
        lifecycle.addObserver(controller)
        return DroneListScreen(carContext, controller)
    }
}

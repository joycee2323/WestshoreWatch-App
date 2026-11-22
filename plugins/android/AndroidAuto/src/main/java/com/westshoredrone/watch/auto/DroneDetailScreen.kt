package com.westshoredrone.watch.auto

import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.car.app.CarContext
import androidx.car.app.CarToast
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Pane
import androidx.car.app.model.PaneTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

/**
 * Detail pane for one drone, with "Navigate to drone" / "Navigate to operator".
 *
 * Refresh-safe: the title and the four row titles never change while this
 * screen is up, so live value updates are free refreshes. If the drone goes
 * silent, the last known values stay on screen marked "Signal lost" (and
 * navigation still works to the last position).
 */
class DroneDetailScreen(
    carContext: CarContext,
    private val controller: AutoController,
    private val uasId: String,
    initial: TrackedDrone?,
) : Screen(carContext), DefaultLifecycleObserver {

    private val main = Handler(Looper.getMainLooper())
    private val throttle = RefreshThrottle()
    private var pendingInvalidate = false
    private var last: TrackedDrone? = initial ?: controller.tracker.get(uasId)
    private val title: String = last?.displayName ?: uasId

    private val onData: () -> Unit = { requestUpdate() }
    private val deferred = Runnable {
        pendingInvalidate = false
        throttle.markSent(System.currentTimeMillis())
        invalidate()
    }

    init {
        lifecycle.addObserver(this)
    }

    override fun onCreate(owner: LifecycleOwner) { controller.addListener(onData) }

    override fun onDestroy(owner: LifecycleOwner) {
        controller.removeListener(onData)
        main.removeCallbacks(deferred)
    }

    private fun requestUpdate() {
        if (pendingInvalidate) return
        val wait = throttle.delayUntilAllowed(System.currentTimeMillis())
        pendingInvalidate = true
        main.postDelayed(deferred, wait)
    }

    // setTitle/setHeaderAction are deprecated in favour of setHeader(Header), but
    // setHeader needs Car API 7 and we support hosts from API 5 (minCarApiLevel).
    @Suppress("DEPRECATION")
    override fun onGetTemplate(): Template {
        val now = System.currentTimeMillis()
        val live = controller.tracker.get(uasId)
        if (live != null) last = live
        val d = last
            ?: return MessageTemplate.Builder("This drone is no longer being detected.")
                .setTitle(title)
                .setHeaderAction(Action.BACK)
                .build()

        val origin = controller.origin
        val lost = live == null

        val positionText = buildString {
            if (origin != null) {
                val dist = Geo.distanceMeters(origin.lat, origin.lon, d.lat, d.lon)
                val brg = Geo.bearingDeg(origin.lat, origin.lon, d.lat, d.lon)
                append("${Fmt.distance(dist)} ${Geo.cardinal(brg)} of you")
            } else {
                append("Your location is unavailable")
            }
        }
        val seenText = if (lost) "Signal lost · last seen ${Fmt.age(now - d.lastSeenMs)}"
        else if (d.isOnGround) "On ground · seen ${Fmt.age(now - d.lastSeenMs)}"
        else "Seen ${Fmt.age(now - d.lastSeenMs)}"

        val opLat = d.opLat
        val opLon = d.opLon
        val operatorText = if (opLat != null && opLon != null && d.hasOperator) {
            if (origin != null) {
                val dist = Geo.distanceMeters(origin.lat, origin.lon, opLat, opLon)
                val brg = Geo.bearingDeg(origin.lat, origin.lon, opLat, opLon)
                "${Fmt.distance(dist)} ${Geo.cardinal(brg)} of you"
            } else {
                String.format(java.util.Locale.US, "%.5f, %.5f", opLat, opLon)
            }
        } else {
            "Not broadcast"
        }

        val pane = Pane.Builder()
            .addRow(Row.Builder().setTitle("Position").addText(positionText).addText(seenText).build())
            .addRow(
                Row.Builder().setTitle("Altitude · speed · heading")
                    .addText("${Fmt.altitude(d.altitudeM, d.altitudeKind)} · ${Fmt.speed(d.speedMps)}")
                    .addText("Heading ${Fmt.heading(d.headingDeg)}")
                    .build(),
            )
            .addRow(Row.Builder().setTitle("Operator").addText(operatorText).build())
            .addRow(Row.Builder().setTitle("Remote ID").addText(d.uasId).build())
            .addAction(
                Action.Builder().setTitle("Navigate to drone")
                    .setFlags(Action.FLAG_PRIMARY)
                    .setOnClickListener { navigateTo(d.lat, d.lon) }
                    .build(),
            )
        if (opLat != null && opLon != null && d.hasOperator) {
            pane.addAction(
                Action.Builder().setTitle("Navigate to operator")
                    .setOnClickListener { navigateTo(opLat, opLon) }
                    .build(),
            )
        }

        controller.alerter.poll(now, needsRefreshTap = false)?.let { msg ->
            main.post { CarToast.makeText(carContext, msg, CarToast.LENGTH_LONG).show() }
        }

        return PaneTemplate.Builder(pane.build())
            .setTitle(title)
            .setHeaderAction(Action.BACK)
            .build()
    }

    private fun navigateTo(lat: Double, lon: Double) {
        try {
            carContext.startCarApp(Intent(CarContext.ACTION_NAVIGATE, Uri.parse(Geo.geoUri(lat, lon))))
        } catch (t: Throwable) {
            Log.w(TAG, "navigate failed: ${t.message}")
            CarToast.makeText(carContext, "Couldn't start navigation", CarToast.LENGTH_LONG).show()
        }
    }

    companion object {
        private const val TAG = "WswAutoDetail"
    }
}

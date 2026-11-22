package com.westshoredrone.watch.auto

import android.Manifest
import android.os.Handler
import android.os.Looper
import android.text.SpannableString
import android.text.Spanned
import androidx.car.app.CarContext
import androidx.car.app.CarToast
import androidx.car.app.Screen
import androidx.car.app.constraints.ConstraintManager
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarColor
import androidx.car.app.model.CarLocation
import androidx.car.app.model.Distance
import androidx.car.app.model.DistanceSpan
import androidx.car.app.model.ForegroundCarColorSpan
import androidx.car.app.model.ItemList
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Metadata
import androidx.car.app.model.Place
import androidx.car.app.model.PlaceListMapTemplate
import androidx.car.app.model.PlaceMarker
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

/**
 * Main car screen: host-drawn map + list of live drones (and their operators),
 * nearest first. See [ListRefreshPolicy] for how updates stay inside the
 * host's template quota, and [RefreshThrottle] for the update rate.
 */
class DroneListScreen(
    carContext: CarContext,
    private val controller: AutoController,
) : Screen(carContext), DefaultLifecycleObserver {

    private val main = Handler(Looper.getMainLooper())
    private val policy = ListRefreshPolicy()
    private val throttle = RefreshThrottle()
    private var pendingInvalidate = false
    private var lastPending = false
    private var shownContent = false
    private var maxRows = -1
    private var appDrivenRefresh: Boolean? = null

    private val onData: () -> Unit = { requestUpdate() }
    private val deferredInvalidate = Runnable {
        pendingInvalidate = false
        sendUpdate()
    }

    init {
        lifecycle.addObserver(this)
    }

    override fun onCreate(owner: LifecycleOwner) { controller.addListener(onData) }

    override fun onDestroy(owner: LifecycleOwner) {
        controller.removeListener(onData)
        main.removeCallbacks(deferredInvalidate)
    }

    override fun onResume(owner: LifecycleOwner) {
        // Back from the detail screen: the host treats this template as a back
        // operation, so it may show the current rows without spending quota.
        policy.rebase()
    }

    private fun requestUpdate() {
        if (pendingInvalidate) return
        val wait = throttle.delayUntilAllowed(now())
        if (wait == 0L) {
            sendUpdate()
        } else {
            pendingInvalidate = true
            main.postDelayed(deferredInvalidate, wait)
        }
    }

    private fun sendUpdate() {
        throttle.markSent(now())
        invalidate()
    }

    override fun onGetTemplate(): Template {
        if (controller.feedStatus == FeedStatus.SIGNED_OUT) return signedOutTemplate()

        val base = PlaceListMapTemplate.Builder()
            .setTitle(TITLE)
            .setHeaderAction(Action.APP_ICON)
            .setCurrentLocationEnabled(controller.hasLocationPermission())

        if (!controller.hasInitialData) {
            // Loading first: the next (content) template then counts as a refresh.
            policy.rebase()
            return base.setLoading(true).build()
        }

        val origin = controller.origin
        val drones = controller.tracker.snapshot()
        val desired = ListPlanner.plan(drones, origin, rowLimit(), policy.shownDroneOrder())
        val decision = policy.decide(desired, ListPlanner.candidates(drones, origin), isAppDrivenRefresh())
        if (!shownContent) {
            shownContent = true
            controller.armAlerts()
        }

        val now = now()
        val list = ItemList.Builder().setNoItemsMessage(emptyMessage())
        for (row in decision.rows) list.addItem(buildRow(row, now))
        base.setItemList(list.build())
            .setOnContentRefreshListener {
                // User-initiated refresh: free, shows the current set.
                policy.rebase()
                controller.retryFeed()
                sendUpdate()
            }

        actionStrip()?.let { base.setActionStrip(it) }

        maybeToast(now, decision.pending)
        lastPending = decision.pending
        return base.build()
    }

    private fun buildRow(display: DisplayRow, now: Long): Row {
        val spec = display.spec
        val drone = controller.tracker.get(spec.uasId)
        val row = Row.Builder().setTitle(spec.title)

        // Line 1: [distance] · direction · altitude · speed (drone) / [distance] · direction (operator)
        val parts = ArrayList<String>()
        spec.bearingDeg?.let { parts += Geo.cardinal(it) }
        if (!spec.isOperator && drone != null) {
            parts += Fmt.altitude(drone.altitudeM, drone.altitudeKind)
            parts += Fmt.speed(drone.speedMps)
        }
        val distance = spec.distanceM
        if (distance != null) {
            row.addText(withDistance(distance, parts.joinToString(" · ")))
        } else {
            // No phone location: a row without a DistanceSpan must be browsable.
            row.setBrowsable(true)
            row.addText(if (parts.isEmpty()) "Location off" else parts.joinToString(" · "))
        }

        // Line 2: freshness / state.
        row.addText(statusLine(display, drone, now))

        val marker = PlaceMarker.Builder()
        if (spec.isOperator) {
            marker.setColor(CarColor.BLUE).setLabel("OP")
        } else {
            marker.setColor(if (display.lost || drone?.isOnGround == true) CarColor.DEFAULT else CarColor.RED)
        }
        row.setMetadata(
            Metadata.Builder().setPlace(
                Place.Builder(CarLocation.create(spec.lat, spec.lon)).setMarker(marker.build()).build(),
            ).build(),
        )
        row.setOnClickListener {
            screenManager.push(DroneDetailScreen(carContext, controller, spec.uasId, drone))
        }
        return row.build()
    }

    private fun statusLine(display: DisplayRow, drone: TrackedDrone?, now: Long): CharSequence {
        if (display.lost || drone == null) return "Signal lost"
        val seen = "Seen ${Fmt.age(now - drone.lastSeenMs)}"
        if (display.spec.isOperator) return "Operator position · $seen"
        if (drone.isOnGround) return "On ground · $seen"
        if (now - drone.firstSeenMs < NEW_HIGHLIGHT_MS) {
            val s = SpannableString("NEW · $seen")
            s.setSpan(ForegroundCarColorSpan.create(CarColor.RED), 0, 3, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            return s
        }
        return seen
    }

    private fun withDistance(meters: Double, rest: String): CharSequence {
        val d = Fmt.carDistance(meters)
        val unit = if (d.unit == DistanceUnit.FEET) Distance.UNIT_FEET else Distance.UNIT_MILES_P1
        val text = if (rest.isEmpty()) " " else "  · $rest"
        val s = SpannableString(text)
        s.setSpan(DistanceSpan.create(Distance.create(d.value, unit)), 0, 1, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
        return s
    }

    private fun emptyMessage(): String {
        val feed = when (controller.feedStatus) {
            FeedStatus.CONNECTED -> "Live feed connected"
            FeedStatus.CONNECTING -> "Connecting to live feed…"
            FeedStatus.OFFLINE -> "Live feed offline, retrying"
            else -> "Live feed idle"
        }
        val loc = if (controller.hasLocationPermission()) "" else " · Location off"
        return "No drones detected · $feed$loc"
    }

    private fun actionStrip(): ActionStrip? {
        if (controller.hasLocationPermission()) return null
        return ActionStrip.Builder().addAction(
            Action.Builder().setTitle("Allow location").setOnClickListener {
                carContext.requestPermissions(
                    listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                ) { granted, _ ->
                    if (granted.isNotEmpty()) controller.onLocationPermissionChanged()
                }
            }.build(),
        ).build()
    }

    private fun maybeToast(now: Long, pending: Boolean) {
        val msg = controller.alerter.poll(now, needsRefreshTap = pending) ?: return
        main.post { CarToast.makeText(carContext, msg, CarToast.LENGTH_LONG).show() }
    }

    // setTitle/setHeaderAction are deprecated in favour of setHeader(Header), but
    // setHeader needs Car API 7 and we support hosts from API 5 (minCarApiLevel).
    @Suppress("DEPRECATION")
    private fun signedOutTemplate(): Template =
        MessageTemplate.Builder(
            "Open Westshore Watch on your phone and sign in to see live drones here.",
        )
            .setTitle("Sign in on your phone")
            .setHeaderAction(Action.APP_ICON)
            .addAction(
                Action.Builder().setTitle("Try again").setOnClickListener {
                    controller.retryFeed()
                }.build(),
            )
            .build()

    private fun rowLimit(): Int {
        if (maxRows < 0) {
            maxRows = try {
                carContext.getCarService(ConstraintManager::class.java)
                    .getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_PLACE_LIST)
            } catch (_: Throwable) {
                DEFAULT_ROW_LIMIT
            }.coerceIn(1, MAX_ROWS)
        }
        return maxRows
    }

    private fun isAppDrivenRefresh(): Boolean {
        appDrivenRefresh?.let { return it }
        val v = try {
            carContext.carAppApiLevel >= 6 &&
                carContext.getCarService(ConstraintManager::class.java).isAppDrivenRefreshEnabled
        } catch (_: Throwable) {
            false
        }
        appDrivenRefresh = v
        return v
    }

    private fun now() = System.currentTimeMillis()

    companion object {
        private const val TITLE = "Live drones"
        private const val DEFAULT_ROW_LIMIT = 6
        private const val MAX_ROWS = 12
        private const val NEW_HIGHLIGHT_MS = 30_000L
    }
}

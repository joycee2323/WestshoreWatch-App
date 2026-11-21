package com.westshoredrone.watch.auto

/** A phone/vehicle position used as the origin for distance + bearing. */
data class LatLon(val lat: Double, val lon: Double)

/**
 * One row of the main car list: either a drone or a drone's operator.
 * [title] is the only field the host's refresh check looks at (with the row
 * count), so it holds nothing but the name; everything that changes every
 * second (distance, age, altitude) is rendered into the text lines instead.
 */
data class RowSpec(
    val key: String,
    val uasId: String,
    val isOperator: Boolean,
    val title: String,
    val lat: Double,
    val lon: Double,
    val distanceM: Double?,
    val bearingDeg: Double?,
)

object ListPlanner {
    fun droneKey(uasId: String) = "d:$uasId"
    fun operatorKey(uasId: String) = "o:$uasId"

    /** Every row we could show (one per drone, one per drone with a known operator). */
    fun candidates(drones: List<TrackedDrone>, origin: LatLon?): Map<String, RowSpec> {
        val out = LinkedHashMap<String, RowSpec>()
        for (d in drones) {
            out[droneKey(d.uasId)] = row(droneKey(d.uasId), d.uasId, false, d.displayName, d.lat, d.lon, origin)
            val opLat = d.opLat
            val opLon = d.opLon
            if (opLat != null && opLon != null && d.hasOperator) {
                out[operatorKey(d.uasId)] =
                    row(operatorKey(d.uasId), d.uasId, true, "Operator · ${d.displayName}", opLat, opLon, origin)
            }
        }
        return out
    }

    /**
     * The rows to show, at most [maxRows]: drones first, then operators for the
     * shown drones while there's room (drones always win the limited slots).
     *
     * Ordering is by distance (nearest first; by first-seen when there's no
     * location). It is STICKY: when the set of shown drones is the same as in
     * [previousDroneOrder], that order is kept even if the distances have
     * swapped. That keeps rows from jumping under a driver's eyes, and it keeps
     * row titles in place, which is what lets the host treat the update as a
     * free refresh instead of a new template.
     */
    fun plan(
        drones: List<TrackedDrone>,
        origin: LatLon?,
        maxRows: Int,
        previousDroneOrder: List<String>?,
    ): List<RowSpec> {
        if (maxRows <= 0 || drones.isEmpty()) return emptyList()
        val all = candidates(drones, origin)
        val byId = drones.associateBy { it.uasId }

        val sorted = drones.sortedWith(
            compareBy<TrackedDrone>(
                { d -> all[droneKey(d.uasId)]?.distanceM ?: Double.MAX_VALUE },
                { d -> d.firstSeenMs },
                { d -> d.uasId },
            ),
        )
        val chosen = sorted.take(maxRows).map { it.uasId }

        val prev = previousDroneOrder
        val ordered = if (prev != null && prev.size == chosen.size && prev.toSet() == chosen.toSet()) prev else chosen

        val rows = ArrayList<RowSpec>(maxRows)
        for (id in ordered) all[droneKey(id)]?.let { rows += it }
        for (id in ordered) {
            if (rows.size >= maxRows) break
            if (byId[id]?.hasOperator == true) all[operatorKey(id)]?.let { rows += it }
        }
        return rows
    }

    private fun row(
        key: String, uasId: String, isOperator: Boolean, title: String,
        lat: Double, lon: Double, origin: LatLon?,
    ) = RowSpec(
        key = key,
        uasId = uasId,
        isOperator = isOperator,
        title = title,
        lat = lat,
        lon = lon,
        distanceM = origin?.let { Geo.distanceMeters(it.lat, it.lon, lat, lon) },
        bearingDeg = origin?.let { Geo.bearingDeg(it.lat, it.lon, lat, lon) },
    )
}

/** A row as rendered: [lost] = the drone behind it is no longer being heard. */
data class DisplayRow(val spec: RowSpec, val lost: Boolean)

/**
 * Decides what the main list may show without burning the host's template
 * quota (5 templates per task; the next one closes the app with an error).
 *
 * A PlaceListMapTemplate update is a free "refresh" only if the title, the
 * row count, and every row title are unchanged (PlaceListMapTemplate javadoc),
 * or if it answers a user refresh, follows a loading template, or is the
 * template sent when popping back to this screen. Anything else counts.
 *
 * - App-driven refresh hosts (Car API 6+, ConstraintManager
 *   .isAppDrivenRefreshEnabled) may change rows freely.
 * - Otherwise, row-set changes that ADD drones may spend a small budget of
 *   counted templates ([countedBudget], default 2, which leaves room for the
 *   initial template, the detail screen and a spare). Once that's spent, or
 *   when drones only disappear, the shown rows are frozen: still-present ones
 *   keep updating, vanished ones render as "lost", and [Decision.pending]
 *   tells the UI to offer the refresh button / a toast.
 * - [rebase] (user refresh, back navigation, after loading) always shows the
 *   current rows.
 */
class ListRefreshPolicy(private var countedBudget: Int = DEFAULT_COUNTED_BUDGET) {
    data class Decision(val rows: List<DisplayRow>, val pending: Boolean, val counted: Boolean)

    private var shown: List<RowSpec>? = null
    private var rebaseNext = true

    /** Next decision may show anything for free (user refresh, back nav, after loading). */
    fun rebase() { rebaseNext = true }

    fun remainingBudget(): Int = countedBudget

    /** Drone UAS IDs in the order currently shown, for sticky ordering. */
    fun shownDroneOrder(): List<String>? = shown?.filter { !it.isOperator }?.map { it.uasId }

    fun decide(desired: List<RowSpec>, available: Map<String, RowSpec>, appDrivenRefresh: Boolean): Decision {
        val prev = shown
        if (rebaseNext || prev == null || appDrivenRefresh || sameTitles(prev, desired)) {
            rebaseNext = false
            shown = desired
            return Decision(desired.map { DisplayRow(it, lost = false) }, pending = false, counted = false)
        }
        val prevKeys = prev.map { it.key }.toSet()
        val addsRows = desired.any { it.key !in prevKeys }
        if (addsRows && countedBudget > 0) {
            countedBudget--
            shown = desired
            return Decision(desired.map { DisplayRow(it, lost = false) }, pending = false, counted = true)
        }
        // Freeze titles/count; refresh the values behind them.
        val rows = prev.map { old ->
            val fresh = available[old.key]
            if (fresh != null) DisplayRow(fresh.copy(title = old.title), lost = false)
            else DisplayRow(old, lost = true)
        }
        shown = rows.map { it.spec }
        return Decision(rows, pending = true, counted = false)
    }

    private fun sameTitles(a: List<RowSpec>, b: List<RowSpec>): Boolean =
        a.size == b.size && a.indices.all { a[it].title == b[it].title }

    companion object {
        const val DEFAULT_COUNTED_BUDGET = 2
    }
}

/**
 * Minimum spacing between data-driven template updates. No numeric limit is
 * published for refreshes, so this stays at the conservative end of the
 * requested 2-3 s window. User-initiated refreshes and navigation bypass it.
 */
class RefreshThrottle(private val minIntervalMs: Long = DEFAULT_MIN_INTERVAL_MS) {
    private var lastSentMs: Long? = null

    /** 0 = may update now; otherwise how long to wait. */
    fun delayUntilAllowed(nowMs: Long): Long {
        val last = lastSentMs ?: return 0L
        val wait = last + minIntervalMs - nowMs
        return if (wait > 0) wait else 0L
    }

    fun markSent(nowMs: Long) { lastSentMs = nowMs }

    companion object {
        const val DEFAULT_MIN_INTERVAL_MS = 3_000L
    }
}

/**
 * Batches first-sighting alerts into at most one CarToast per [minGapMs], so a
 * swarm produces "3 new drones detected", not a burst. Visual only: the Car App
 * Library gives no sound for toasts, and we add none.
 */
class NewDroneAlerter(private val minGapMs: Long = DEFAULT_MIN_GAP_MS) {
    private val pendingNames = ArrayList<String>()
    private var lastShownMs: Long? = null

    fun onNewDrone(name: String) {
        if (name !in pendingNames) pendingNames += name
    }

    fun hasPending(): Boolean = pendingNames.isNotEmpty()

    /** The message to show now, or null if nothing's pending or it's too soon. */
    fun poll(nowMs: Long, needsRefreshTap: Boolean): String? {
        if (pendingNames.isEmpty()) return null
        val last = lastShownMs
        if (last != null && nowMs - last < minGapMs) return null
        val msg = message(pendingNames, needsRefreshTap)
        pendingNames.clear()
        lastShownMs = nowMs
        return msg
    }

    companion object {
        const val DEFAULT_MIN_GAP_MS = 10_000L

        fun message(names: List<String>, needsRefreshTap: Boolean): String {
            val base = if (names.size == 1) "New drone: ${names[0]}" else "${names.size} new drones detected"
            return if (needsRefreshTap) "$base. Tap refresh to show." else base
        }
    }
}

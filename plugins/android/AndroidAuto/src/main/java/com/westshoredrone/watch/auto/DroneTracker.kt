package com.westshoredrone.watch.auto

import kotlin.math.min

enum class DroneSource { BACKEND, LOCAL_BLE }

/** AGL = backend's alt_agl_m. HEIGHT = drone-reported height above takeoff (local BLE). */
enum class AltitudeKind { AGL, HEIGHT }

/** One sighting of a drone from either feed. Units: meters, m/s, degrees. */
data class DroneObservation(
    val uasId: String,
    val nickname: String?,
    val lat: Double,
    val lon: Double,
    val altitudeM: Double?,
    val altitudeKind: AltitudeKind,
    val speedMps: Double?,
    val headingDeg: Double?,
    val opLat: Double?,
    val opLon: Double?,
    /** When the frame was observed, epoch ms (server last_seen or local receive time). */
    val observedAtMs: Long,
    /** Per-frame on-ground test (status 1, slow, low). Only local frames ever set this. */
    val onGround: Boolean,
    val source: DroneSource,
    /**
     * False when speed/heading came from a legacy (pre-spec) ODID decoder, whose
     * heading is wrong and speed can read ~3x high (backend
     * services/kinematicsDisplay.js). The car then shows neither.
     */
    val kinematicsReliable: Boolean = true,
)

data class TrackedDrone(
    val uasId: String,
    val nickname: String?,
    val lat: Double,
    val lon: Double,
    val altitudeM: Double?,
    val altitudeKind: AltitudeKind,
    val speedMps: Double?,
    val headingDeg: Double?,
    val opLat: Double?,
    val opLon: Double?,
    val firstSeenMs: Long,
    val lastSeenMs: Long,
    /** Start of the current continuous on-ground run, or null when airborne/unknown. */
    val groundedSinceMs: Long?,
) {
    val displayName: String get() = nickname?.takeIf { it.isNotBlank() } ?: uasId
    val hasOperator: Boolean get() = Geo.isValidCoordinate(opLat, opLon)
    val isOnGround: Boolean get() = groundedSinceMs != null
}

/**
 * Session-scoped set of live drones, merged from the backend feed and the
 * local BLE relay, keyed by UAS ID (the car doesn't care which deployment).
 *
 * Eviction matches the node firmware defaults (nvs_config.c): a drone silent for
 * [silenceMs] (15 s) is dropped, and one continuously on the ground for
 * [groundedMs] (5 s) is dropped and suppressed until it reports airborne again
 * (otherwise each new on-ground frame would re-add it and it would flicker).
 *
 * Not thread-safe by itself; callers use it from the main thread.
 */
class DroneTracker(
    private val silenceMs: Long = SILENCE_MS,
    private val groundedMs: Long = GROUNDED_MS,
) {
    data class IngestResult(val changed: Boolean, val firstSightingThisSession: Boolean)

    private val drones = LinkedHashMap<String, TrackedDrone>()
    private val seenThisSession = HashSet<String>()
    private val groundedSuppressed = HashSet<String>()

    fun ingest(obs: DroneObservation, nowMs: Long): IngestResult {
        if (obs.uasId.isBlank() || !Geo.isValidCoordinate(obs.lat, obs.lon)) {
            return IngestResult(changed = false, firstSightingThisSession = false)
        }
        // Server clocks can run ahead of the phone; never place a sighting in the future.
        val seenAt = min(obs.observedAtMs, nowMs)
        // Already too old to show (e.g. REST hydrate rows from minutes ago).
        if (nowMs - seenAt > silenceMs) return IngestResult(false, false)

        if (obs.onGround && obs.uasId in groundedSuppressed) return IngestResult(false, false)
        if (!obs.onGround) groundedSuppressed.remove(obs.uasId)

        val existing = drones[obs.uasId]
        val first = seenThisSession.add(obs.uasId)

        if (existing != null && seenAt < existing.lastSeenMs) {
            // Older than what we have (e.g. hydrate racing the live socket):
            // only pick up a nickname we didn't know yet.
            if (existing.nickname == null && obs.nickname != null) {
                drones[obs.uasId] = existing.copy(nickname = obs.nickname)
                return IngestResult(true, first)
            }
            return IngestResult(false, first)
        }

        val groundedSince = if (obs.onGround) (existing?.groundedSinceMs ?: seenAt) else null
        val useNewAlt = obs.altitudeM != null
        val next = TrackedDrone(
            uasId = obs.uasId,
            nickname = obs.nickname ?: existing?.nickname,
            lat = obs.lat,
            lon = obs.lon,
            altitudeM = if (useNewAlt) obs.altitudeM else existing?.altitudeM,
            altitudeKind = if (useNewAlt) obs.altitudeKind else existing?.altitudeKind ?: obs.altitudeKind,
            speedMps = if (obs.kinematicsReliable) obs.speedMps ?: existing?.speedMps else null,
            headingDeg = if (obs.kinematicsReliable) obs.headingDeg ?: existing?.headingDeg else null,
            opLat = if (Geo.isValidCoordinate(obs.opLat, obs.opLon)) obs.opLat else existing?.opLat,
            opLon = if (Geo.isValidCoordinate(obs.opLat, obs.opLon)) obs.opLon else existing?.opLon,
            firstSeenMs = existing?.firstSeenMs ?: seenAt,
            lastSeenMs = seenAt,
            groundedSinceMs = groundedSince,
        )
        drones[obs.uasId] = next
        return IngestResult(changed = next != existing, firstSightingThisSession = first)
    }

    /** Drops silent and grounded drones. Returns the UAS IDs removed. */
    fun evict(nowMs: Long): List<String> {
        val removed = ArrayList<String>()
        val it = drones.entries.iterator()
        while (it.hasNext()) {
            val d = it.next().value
            val silent = nowMs - d.lastSeenMs > silenceMs
            val grounded = d.groundedSinceMs != null && nowMs - d.groundedSinceMs >= groundedMs
            if (silent || grounded) {
                if (grounded && !silent) groundedSuppressed.add(d.uasId)
                removed += d.uasId
                it.remove()
            }
        }
        return removed
    }

    fun get(uasId: String): TrackedDrone? = drones[uasId]

    fun snapshot(): List<TrackedDrone> = drones.values.toList()

    fun size(): Int = drones.size

    companion object {
        const val SILENCE_MS = 15_000L
        const val GROUNDED_MS = 5_000L
    }
}

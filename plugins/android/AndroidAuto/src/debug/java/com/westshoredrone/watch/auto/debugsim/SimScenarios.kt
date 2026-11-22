package com.westshoredrone.watch.auto.debugsim

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin
import kotlin.random.Random

/*
 * DEBUG BUILDS ONLY (src/debug source set). Fake Remote ID drones for testing
 * the car app on the Desktop Head Unit without real drones. Pure functions of
 * (origin, seed, elapsed time) so they're deterministic and unit-tested
 * (src/testDebug). The runtime that feeds these into the real ingest path is
 * FakeDroneFeed.
 */

/** One fake Remote ID frame, shaped like what BLEScannerService hands LocalDetectionTap. */
data class SimFrame(
    val uasId: String,
    val lat: Double,
    val lon: Double,
    /** Height above takeoff, meters. */
    val heightM: Double,
    val speedMps: Double,
    val headingDeg: Double,
    val opLat: Double?,
    val opLon: Double?,
    /** ODID operational status: 1 = ground, 2 = airborne. */
    val status: Int,
)

data class SimOrigin(val lat: Double, val lon: Double)

interface SimScenario {
    val name: String
    /** Frames stop after this; null = runs until `stop`. */
    val durationMs: Long?
    /** Every frame transmitted at [elapsedMs] since the scenario started. */
    fun framesAt(elapsedMs: Long): List<SimFrame>
}

object SimScenarios {
    const val ONE = "one"
    const val MANY = "many"
    const val CHURN = "churn"
    const val LANDING = "landing"
    const val SILENT = "silent"
    const val STOP = "stop"
    val NAMES = listOf(ONE, MANY, CHURN, LANDING, SILENT)

    /** Used when the phone has no location fix (approx. Brook Park, OH). */
    val BROOK_PARK = SimOrigin(41.3984, -81.8046)

    const val DEFAULT_SEED = 42L
    const val CHURN_DURATION_MS = 15 * 60_000L
    const val CHURN_SLOTS = 3
    const val LANDING_TOUCHDOWN_MS = 40_000L
    const val LANDING_END_MS = 90_000L
    const val SILENT_STOP_MS = 30_000L

    fun create(name: String, origin: SimOrigin, seed: Long = DEFAULT_SEED): SimScenario? = when (name) {
        ONE -> One(origin)
        MANY -> Many(origin, seed)
        CHURN -> Churn(origin, seed)
        LANDING -> Landing(origin)
        SILENT -> Silent(origin)
        else -> null
    }

    // ------------------------------------------------------------ geometry

    private const val M_PER_DEG_LAT = 111_320.0

    /** Point [northM]/[eastM] meters from [o] (flat-earth; fine at these ranges). */
    fun offset(o: SimOrigin, northM: Double, eastM: Double): SimOrigin {
        val lat = o.lat + northM / M_PER_DEG_LAT
        val lon = o.lon + eastM / (M_PER_DEG_LAT * cos(o.lat * PI / 180))
        return SimOrigin(lat, lon)
    }

    /** A drone flying a circle around [center]. Clockwise seen from above. */
    data class Orbit(
        val center: SimOrigin,
        val radiusM: Double,
        val periodMs: Long,
        val phaseDeg: Double,
        val heightM: Double,
    ) {
        val speedMps: Double get() = 2 * PI * radiusM / (periodMs / 1000.0)

        /** Position and heading at [tMs]; bearing measured clockwise from north. */
        fun at(tMs: Long): Triple<SimOrigin, Double, Double> {
            val bearing = phaseDeg + 360.0 * (tMs % periodMs) / periodMs
            val rad = bearing * PI / 180
            val p = offset(center, radiusM * cos(rad), radiusM * sin(rad))
            val heading = (bearing + 90.0) % 360.0
            return Triple(p, heading, speedMps)
        }
    }

    private fun orbitFrame(id: String, o: Orbit, tMs: Long, op: SimOrigin?): SimFrame {
        val (p, hdg, spd) = o.at(tMs)
        return SimFrame(id, p.lat, p.lon, o.heightM, spd, hdg, op?.lat, op?.lon, status = 2)
    }

    // ------------------------------------------------------------ scenarios

    /** One drone circling the phone at 300 m; operator 140 m south-west. */
    class One(origin: SimOrigin) : SimScenario {
        override val name = ONE
        override val durationMs: Long? = null
        val orbit = Orbit(origin, radiusM = 300.0, periodMs = 150_000, phaseDeg = 0.0, heightM = 60.0)
        val operator = offset(origin, -100.0, -100.0)
        override fun framesAt(elapsedMs: Long) = listOf(orbitFrame("SIM-ONE-1", orbit, elapsedMs, operator))
    }

    /** Eight drones on different orbits (200 m to 1.6 km), to exercise the row limit. */
    class Many(origin: SimOrigin, seed: Long) : SimScenario {
        override val name = MANY
        override val durationMs: Long? = null
        val orbits: List<Orbit>
        init {
            val r = Random(seed)
            orbits = (0 until 8).map { i ->
                val centerBearing = r.nextDouble(0.0, 360.0) * PI / 180
                val centerDist = 200.0 + i * 200.0
                val center = offset(origin, centerDist * cos(centerBearing), centerDist * sin(centerBearing))
                Orbit(
                    center = center,
                    radiusM = r.nextDouble(60.0, 180.0),
                    periodMs = r.nextLong(60_000, 180_000),
                    phaseDeg = r.nextDouble(0.0, 360.0),
                    heightM = r.nextDouble(30.0, 110.0),
                )
            }
        }
        override fun framesAt(elapsedMs: Long) =
            orbits.mapIndexed { i, o -> orbitFrame("SIM-MANY-${i + 1}", o, elapsedMs, o.center) }
    }

    /**
     * Drones that appear and disappear every 20-40 s for 15 minutes, to soak-test
     * the template quota. [CHURN_SLOTS] independent slots; each alternates a
     * 20-40 s "life" (new UAS ID each time) with a 20-40 s gap.
     */
    class Churn(origin: SimOrigin, seed: Long) : SimScenario {
        data class Life(val uasId: String, val startMs: Long, val endMs: Long, val orbit: Orbit, val op: SimOrigin)

        override val name = CHURN
        override val durationMs: Long = CHURN_DURATION_MS
        val lives: List<Life>
        init {
            val r = Random(seed)
            val out = ArrayList<Life>()
            var n = 0
            repeat(CHURN_SLOTS) { slot ->
                // Stagger the slots so they don't all change at once.
                var t = slot * 10_000L
                while (true) {
                    val len = r.nextLong(20_000, 40_001)
                    if (t + len > CHURN_DURATION_MS) break
                    val dist = r.nextDouble(150.0, 1200.0)
                    val b = r.nextDouble(0.0, 2 * PI)
                    val center = offset(origin, dist * cos(b), dist * sin(b))
                    n += 1
                    out += Life(
                        uasId = "SIM-CHURN-$n",
                        startMs = t,
                        endMs = t + len,
                        orbit = Orbit(center, r.nextDouble(40.0, 150.0), r.nextLong(40_000, 120_000), r.nextDouble(0.0, 360.0), r.nextDouble(25.0, 100.0)),
                        op = offset(center, r.nextDouble(-80.0, 80.0), r.nextDouble(-80.0, 80.0)),
                    )
                    t += len + r.nextLong(20_000, 40_001)
                }
            }
            lives = out.sortedBy { it.startMs }
        }
        override fun framesAt(elapsedMs: Long) = lives
            .filter { elapsedMs >= it.startMs && elapsedMs < it.endMs }
            .map { orbitFrame(it.uasId, it.orbit, elapsedMs - it.startMs, it.op) }
    }

    /**
     * One drone 400 m east: level at 60 m for 10 s, descends at 2 m/s, touches down
     * at 40 s and keeps transmitting on the ground (status 1, speed 0, height 0)
     * until 90 s. The car should drop it ~5 s after touchdown.
     */
    class Landing(origin: SimOrigin) : SimScenario {
        override val name = LANDING
        override val durationMs: Long = LANDING_END_MS
        private val start = offset(origin, 0.0, 400.0)
        private val operator = offset(origin, 0.0, 330.0)
        override fun framesAt(elapsedMs: Long): List<SimFrame> {
            if (elapsedMs >= LANDING_END_MS) return emptyList()
            val t = elapsedMs / 1000.0
            return if (elapsedMs < LANDING_TOUCHDOWN_MS) {
                // Drift north at 1 m/s while descending (so the row visibly updates).
                val height = if (t < 10) 60.0 else max(0.5, 60.0 - 2.0 * (t - 10))
                val p = offset(start, t, 0.0)
                listOf(SimFrame("SIM-LAND-1", p.lat, p.lon, height, 1.0, 0.0, operator.lat, operator.lon, status = 2))
            } else {
                val p = offset(start, LANDING_TOUCHDOWN_MS / 1000.0, 0.0)
                listOf(SimFrame("SIM-LAND-1", p.lat, p.lon, 0.0, 0.0, 0.0, operator.lat, operator.lon, status = 1))
            }
        }
    }

    /** One drone circling at 250 m for 30 s, then it stops transmitting. */
    class Silent(origin: SimOrigin) : SimScenario {
        override val name = SILENT
        override val durationMs: Long = SILENT_STOP_MS
        private val orbit = Orbit(origin, radiusM = 250.0, periodMs = 120_000, phaseDeg = 90.0, heightM = 45.0)
        private val operator = offset(origin, 120.0, 0.0)
        override fun framesAt(elapsedMs: Long) =
            if (elapsedMs >= SILENT_STOP_MS) emptyList()
            else listOf(orbitFrame("SIM-SILENT-1", orbit, elapsedMs, operator))
    }
}

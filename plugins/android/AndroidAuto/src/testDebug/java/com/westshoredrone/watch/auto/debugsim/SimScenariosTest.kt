package com.westshoredrone.watch.auto.debugsim

import com.westshoredrone.watch.auto.AltitudeKind
import com.westshoredrone.watch.auto.DroneObservation
import com.westshoredrone.watch.auto.DroneSource
import com.westshoredrone.watch.auto.DroneTracker
import com.westshoredrone.watch.auto.Geo
import com.westshoredrone.watch.auto.LocalDetectionTap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Debug-only simulator (src/testDebug: runs in testDebugUnitTest; release has no
 * simulator classes to test). Generators are pure in (origin, seed, time).
 */
class SimScenariosTest {
    private val origin = SimScenarios.BROOK_PARK

    private fun dist(f: SimFrame) = Geo.distanceMeters(origin.lat, origin.lon, f.lat, f.lon)

    /** The conversion LocalDetectionTap does, so tests drive the real DroneTracker the same way. */
    private fun toObs(f: SimFrame, nowMs: Long) = DroneObservation(
        uasId = f.uasId, nickname = null, lat = f.lat, lon = f.lon,
        altitudeM = f.heightM, altitudeKind = AltitudeKind.HEIGHT,
        speedMps = f.speedMps, headingDeg = f.headingDeg, opLat = f.opLat, opLon = f.opLon,
        observedAtMs = nowMs,
        onGround = LocalDetectionTap.isOnGroundFrame(f.status, f.speedMps, f.heightM),
        source = DroneSource.LOCAL_BLE, kinematicsReliable = true,
    )

    /** Runs a scenario at 1 Hz into a real DroneTracker; returns tracker size per second. */
    private fun simulate(s: SimScenario, seconds: Int): List<Int> {
        val tracker = DroneTracker()
        val t0 = 1_000_000L
        return (0..seconds).map { sec ->
            val now = t0 + sec * 1000L
            for (f in s.framesAt(sec * 1000L)) tracker.ingest(toObs(f, now), now)
            tracker.evict(now)
            tracker.size()
        }
    }

    @Test fun `create knows every scenario and rejects unknown names`() {
        for (n in SimScenarios.NAMES) assertNotNull(n, SimScenarios.create(n, origin))
        assertNull(SimScenarios.create("nope", origin))
        assertNull(SimScenarios.create(SimScenarios.STOP, origin))
    }

    @Test fun `same seed gives identical frames, different seed differs`() {
        for (n in listOf(SimScenarios.MANY, SimScenarios.CHURN)) {
            val a = SimScenarios.create(n, origin, 7)!!
            val b = SimScenarios.create(n, origin, 7)!!
            val c = SimScenarios.create(n, origin, 8)!!
            for (t in listOf(0L, 12_345L, 61_000L, 300_000L)) assertEquals(a.framesAt(t), b.framesAt(t))
            assertNotEquals(a.framesAt(61_000L), c.framesAt(61_000L))
        }
    }

    @Test fun `one - single drone circling about 300 m away with an operator`() {
        val s = SimScenarios.create(SimScenarios.ONE, origin)!!
        for (t in 0L..300_000L step 7_000L) {
            val frames = s.framesAt(t)
            assertEquals(1, frames.size)
            val f = frames[0]
            assertEquals(300.0, dist(f), 3.0)
            assertTrue(Geo.isValidCoordinate(f.opLat, f.opLon))
            assertEquals(2, f.status)
            assertTrue(f.speedMps in 5.0..30.0)
        }
        // It actually moves around the circle.
        assertTrue(Geo.distanceMeters(s.framesAt(0)[0].lat, s.framesAt(0)[0].lon, s.framesAt(75_000)[0].lat, s.framesAt(75_000)[0].lon) > 500)
        assertNull(s.durationMs)
    }

    @Test fun `many - eight distinct airborne drones every tick, more than the row limit`() {
        val s = SimScenarios.create(SimScenarios.MANY, origin)!!
        for (t in listOf(0L, 30_000L, 600_000L)) {
            val frames = s.framesAt(t)
            assertEquals(8, frames.map { it.uasId }.toSet().size)
            assertTrue(frames.all { it.status == 2 && dist(it) < 2_500 })
        }
        assertEquals(8, simulate(s, 60).last())
    }

    @Test fun `churn - lives of 20-40 s, gaps of 20-40 s, ends at 15 minutes`() {
        val s = SimScenarios.create(SimScenarios.CHURN, origin) as SimScenarios.Churn
        assertEquals(15 * 60_000L, s.durationMs)
        assertTrue(s.lives.size >= 30)
        assertEquals(s.lives.size, s.lives.map { it.uasId }.toSet().size)
        for (l in s.lives) {
            assertTrue(l.endMs - l.startMs in 20_000L..40_000L)
            assertTrue(l.endMs <= SimScenarios.CHURN_DURATION_MS)
        }
        var maxConcurrent = 0
        for (t in 0L until SimScenarios.CHURN_DURATION_MS step 1_000L) {
            maxConcurrent = maxOf(maxConcurrent, s.framesAt(t).size)
        }
        assertTrue(maxConcurrent in 2..SimScenarios.CHURN_SLOTS)
        assertTrue(s.framesAt(SimScenarios.CHURN_DURATION_MS).isEmpty())
        // Membership actually changes many times (what the quota soak needs).
        var changes = 0
        var prev = emptySet<String>()
        for (t in 0L until SimScenarios.CHURN_DURATION_MS step 1_000L) {
            val ids = s.framesAt(t).map { it.uasId }.toSet()
            if (ids != prev) changes++
            prev = ids
        }
        assertTrue("membership changes=$changes", changes >= 40)
    }

    @Test fun `landing - descends, goes on-ground, tracker drops it about 5 s after touchdown`() {
        val s = SimScenarios.create(SimScenarios.LANDING, origin)!!
        val before = s.framesAt(20_000)[0]
        assertEquals(2, before.status)
        assertTrue(before.heightM in 35.0..45.0)
        assertFalse(LocalDetectionTap.isOnGroundFrame(before.status, before.speedMps, before.heightM))
        val after = s.framesAt(SimScenarios.LANDING_TOUCHDOWN_MS + 1_000)[0]
        assertTrue(LocalDetectionTap.isOnGroundFrame(after.status, after.speedMps, after.heightM))

        val sizes = simulate(s, 100)
        val touchdown = (SimScenarios.LANDING_TOUCHDOWN_MS / 1000).toInt()
        assertEquals(1, sizes[touchdown - 1])
        assertEquals(1, sizes[touchdown + 3])          // still listed shortly after landing
        assertEquals(0, sizes[touchdown + 5])          // grounded eviction (5 s)
        // Keeps transmitting on the ground until 90 s but stays suppressed (no flicker).
        assertTrue(sizes.drop(touchdown + 5).all { it == 0 })
    }

    @Test fun `silent - transmits 30 s, then nothing, tracker evicts 15 s later`() {
        val s = SimScenarios.create(SimScenarios.SILENT, origin)!!
        assertEquals(1, s.framesAt(29_000).size)
        assertTrue(s.framesAt(30_000).isEmpty())
        val sizes = simulate(s, 60)
        assertEquals(1, sizes[29])
        assertEquals(1, sizes[44])   // 15 s of silence: still listed ("Signal lost" pending)
        assertEquals(0, sizes[46])   // evicted
    }

    @Test fun `offset moves the expected distance`() {
        val p = SimScenarios.offset(origin, 300.0, 400.0)
        assertEquals(500.0, Geo.distanceMeters(origin.lat, origin.lon, p.lat, p.lon), 2.0)
    }
}

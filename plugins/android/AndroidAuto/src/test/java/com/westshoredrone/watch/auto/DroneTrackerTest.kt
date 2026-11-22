package com.westshoredrone.watch.auto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DroneTrackerTest {
    private fun obs(
        id: String = "A",
        at: Long = 1_000L,
        lat: Double = 41.5,
        lon: Double = -81.7,
        onGround: Boolean = false,
        nickname: String? = null,
        speed: Double? = 5.0,
        heading: Double? = 90.0,
        reliable: Boolean = true,
        alt: Double? = 30.0,
        kind: AltitudeKind = AltitudeKind.AGL,
    ) = DroneObservation(
        uasId = id, nickname = nickname, lat = lat, lon = lon, altitudeM = alt, altitudeKind = kind,
        speedMps = speed, headingDeg = heading, opLat = null, opLon = null, observedAtMs = at,
        onGround = onGround, source = DroneSource.BACKEND, kinematicsReliable = reliable,
    )

    @Test fun ingest_newDrone_isTrackedAndFirstSighting() {
        val t = DroneTracker()
        val r = t.ingest(obs(), nowMs = 1_000)
        assertTrue(r.changed)
        assertTrue(r.firstSightingThisSession)
        assertEquals(1, t.size())
    }

    @Test fun ingest_rejectsNoFixAndBlankIds() {
        val t = DroneTracker()
        assertFalse(t.ingest(obs(lat = 0.0, lon = 0.0), 1_000).changed)
        assertFalse(t.ingest(obs(id = " "), 1_000).changed)
        assertEquals(0, t.size())
    }

    @Test fun ingest_ignoresObservationsAlreadyPastTheSilenceWindow() {
        val t = DroneTracker()
        assertFalse(t.ingest(obs(at = 0), nowMs = 15_001).changed)
        assertEquals(0, t.size())
    }

    @Test fun ingest_futureServerTimestamp_isClampedToNow() {
        val t = DroneTracker()
        t.ingest(obs(at = 9_000), nowMs = 1_000)
        assertEquals(1_000L, t.get("A")!!.lastSeenMs)
    }

    @Test fun ingest_olderObservation_doesNotMoveDroneBackwards_butFillsNickname() {
        val t = DroneTracker()
        t.ingest(obs(at = 5_000, lat = 41.6), 5_000)
        val r = t.ingest(obs(at = 4_000, lat = 41.4, nickname = "Blue"), 5_000)
        assertTrue(r.changed)
        assertEquals(41.6, t.get("A")!!.lat, 0.0)
        assertEquals("Blue", t.get("A")!!.nickname)
        assertEquals(5_000L, t.get("A")!!.lastSeenMs)
    }

    @Test fun ingest_secondSighting_isNotFirstSighting_evenAfterEviction() {
        val t = DroneTracker()
        t.ingest(obs(at = 0), 0)
        t.evict(20_000)
        assertNull(t.get("A"))
        val r = t.ingest(obs(at = 20_000), 20_000)
        assertFalse(r.firstSightingThisSession)
        assertEquals(20_000L, t.get("A")!!.firstSeenMs)
    }

    @Test fun ingest_keepsKnownNicknameWhenLocalFrameHasNone() {
        val t = DroneTracker()
        t.ingest(obs(at = 1_000, nickname = "Blue"), 1_000)
        t.ingest(obs(at = 2_000, nickname = null), 2_000)
        assertEquals("Blue", t.get("A")!!.displayName)
    }

    @Test fun ingest_unreliableKinematics_hidesSpeedAndHeading() {
        val t = DroneTracker()
        t.ingest(obs(at = 1_000), 1_000)
        t.ingest(obs(at = 2_000, reliable = false, speed = 60.0, heading = 45.0), 2_000)
        assertNull(t.get("A")!!.speedMps)
        assertNull(t.get("A")!!.headingDeg)
    }

    @Test fun ingest_missingAltitude_keepsPreviousAltitudeAndKind() {
        val t = DroneTracker()
        t.ingest(obs(at = 1_000, alt = 30.0, kind = AltitudeKind.AGL), 1_000)
        t.ingest(obs(at = 2_000, alt = null, kind = AltitudeKind.HEIGHT), 2_000)
        assertEquals(30.0, t.get("A")!!.altitudeM!!, 0.0)
        assertEquals(AltitudeKind.AGL, t.get("A")!!.altitudeKind)
    }

    @Test fun evict_after15sOfSilence() {
        val t = DroneTracker()
        t.ingest(obs(at = 0), 0)
        assertTrue(t.evict(15_000).isEmpty())
        assertEquals(listOf("A"), t.evict(15_001))
    }

    @Test fun evict_after5sContinuouslyOnGround_andStaysSuppressedUntilAirborne() {
        val t = DroneTracker()
        t.ingest(obs(at = 0, onGround = true), 0)
        t.ingest(obs(at = 3_000, onGround = true), 3_000)
        assertTrue(t.get("A")!!.isOnGround)
        assertTrue(t.evict(4_999).isEmpty())
        assertEquals(listOf("A"), t.evict(5_000))
        // Further on-ground frames don't bring it back (no flicker).
        assertFalse(t.ingest(obs(at = 6_000, onGround = true), 6_000).changed)
        assertNull(t.get("A"))
        // Takeoff brings it back.
        assertTrue(t.ingest(obs(at = 7_000, onGround = false), 7_000).changed)
        assertFalse(t.get("A")!!.isOnGround)
    }

    @Test fun groundedRun_resetsWhenAirborneAgain() {
        val t = DroneTracker()
        t.ingest(obs(at = 0, onGround = true), 0)
        t.ingest(obs(at = 4_000, onGround = false), 4_000)
        t.ingest(obs(at = 6_000, onGround = true), 6_000)
        assertTrue(t.evict(10_000).isEmpty())
        assertEquals(listOf("A"), t.evict(11_000))
    }
}

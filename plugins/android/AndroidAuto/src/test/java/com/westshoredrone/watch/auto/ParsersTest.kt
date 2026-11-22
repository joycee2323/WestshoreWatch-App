package com.westshoredrone.watch.auto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ParsersTest {
    private val now = 1_763_700_000_000L // fixed "now" for the tests

    @Test fun ws_droneUpdate_parsesRows() {
        val msg = """
            {"type":"DRONE_UPDATE","deployment_id":"dep1","drones":[
              {"uas_id":"1581F5BKD225L00A","last_lat":41.5,"last_lon":-81.7,"alt_agl_m":36.576,
               "last_speed":5.5,"last_heading":90,"op_lat":41.49,"op_lon":-81.71,
               "last_seen":"2025-11-21T04:39:59.000Z","nickname":"Blue","kinematics_reliable":true},
              {"uas_id":"","last_lat":1,"last_lon":1},
              {"uas_id":"NOFIX","last_lat":0,"last_lon":0}
            ]}
        """.trimIndent()
        val obs = BackendParser.parseWsMessage(msg, now)
        assertEquals(1, obs.size)
        val o = obs[0]
        assertEquals("1581F5BKD225L00A", o.uasId)
        assertEquals("Blue", o.nickname)
        assertEquals(36.576, o.altitudeM!!, 1e-9)
        assertEquals(AltitudeKind.AGL, o.altitudeKind)
        assertEquals(41.49, o.opLat!!, 1e-9)
        assertEquals(DroneSource.BACKEND, o.source)
        assertTrue(o.kinematicsReliable)
        // Server time older than "now": kept.
        assertEquals(BackendParser.parseIsoMs("2025-11-21T04:39:59.000Z"), o.observedAtMs)
    }

    @Test fun ws_otherMessageTypes_yieldNothing() {
        assertTrue(BackendParser.parseWsMessage("""{"type":"SUBSCRIBED_ORG"}""", now).isEmpty())
        assertTrue(BackendParser.parseWsMessage("not json", now).isEmpty())
        assertEquals("SCOPE_CHANGED", BackendParser.messageType("""{"type":"SCOPE_CHANGED"}"""))
        assertNull(BackendParser.messageType("nope"))
    }

    @Test fun rest_decimalStrings_nullsAndFutureTimestamps() {
        val body = """[{"uas_id":"A","last_lat":"41.5000000","last_lon":"-81.7000000",
            "alt_agl_m":null,"last_speed":"3.25","last_heading":null,"op_lat":null,"op_lon":null,
            "last_seen":"2099-01-01T00:00:00Z","nickname":"","kinematics_reliable":false}]"""
        val obs = BackendParser.parseRestArray(body, now)
        assertEquals(1, obs.size)
        val o = obs[0]
        assertEquals(41.5, o.lat, 1e-9)
        assertEquals(3.25, o.speedMps!!, 1e-9)
        assertNull(o.altitudeM)
        assertNull(o.headingDeg)
        assertNull(o.nickname)
        assertFalse(o.kinematicsReliable)
        assertEquals(now, o.observedAtMs) // clamped, never in the future
    }

    @Test fun rest_missingReliabilityFlag_defaultsToReliable_andMissingLastSeenUsesNow() {
        val obs = BackendParser.parseRestArray("""[{"uas_id":"A","last_lat":41.5,"last_lon":-81.7}]""", now)
        assertTrue(obs[0].kinematicsReliable)
        assertEquals(now, obs[0].observedAtMs)
    }

    @Test fun rest_notAnArray_yieldsNothing() {
        assertTrue(BackendParser.parseRestArray("""{"error":"x"}""", now).isEmpty())
    }

    // ---- expo-secure-store item format ----

    @Test fun secureStore_prefKeys_currentThenLegacy() {
        assertEquals(listOf("key_v1-auth_token", "auth_token"), SecureStoreFormat.prefKeys("auth_token"))
    }

    @Test fun secureStore_parse_aesItemWithSuffix() {
        val item = SecureStoreFormat.parse(
            """{"ct":"Y3Q=","iv":"aXY=","tlen":128,"scheme":"aes","usesKeystoreSuffix":true,"keystoreAlias":"key_v1","requireAuthentication":false}""",
        )!!
        assertEquals("AES/GCM/NoPadding:key_v1:keystoreUnauthenticated", item.keystoreAlias)
        assertEquals("Y3Q=", item.ciphertextB64)
        assertEquals(128, item.tagLengthBits)
    }

    @Test fun secureStore_parse_legacyAesItemWithoutSuffix() {
        val item = SecureStoreFormat.parse("""{"ct":"Y3Q=","iv":"aXY=","tlen":128,"scheme":"aes"}""")!!
        assertEquals("AES/GCM/NoPadding:key_v1", item.keystoreAlias)
    }

    @Test fun secureStore_parse_rejectsUnreadableItems() {
        assertNull(SecureStoreFormat.parse("""{"ct":"x","iv":"y","tlen":128,"scheme":"hybrid"}"""))
        assertNull(SecureStoreFormat.parse("""{"ct":"x","iv":"y","tlen":128,"scheme":"aes","requireAuthentication":true}"""))
        assertNull(SecureStoreFormat.parse("""{"ct":"x","iv":"y","tlen":64,"scheme":"aes"}"""))
        assertNull(SecureStoreFormat.parse("""{"iv":"y","tlen":128,"scheme":"aes"}"""))
        assertNull(SecureStoreFormat.parse("garbage"))
    }

    // ---- local BLE on-ground rule (mirrors src/services/onGround.ts) ----

    @Test fun onGround_matchesPhoneRule() {
        assertTrue(LocalDetectionTap.isOnGroundFrame(1, 0.0, 1.0))
        assertTrue(LocalDetectionTap.isOnGroundFrame(1, 0.5, null))
        assertFalse(LocalDetectionTap.isOnGroundFrame(2, 0.0, 0.0))
        assertFalse(LocalDetectionTap.isOnGroundFrame(1, null, 0.0))
        assertFalse(LocalDetectionTap.isOnGroundFrame(1, 0.6, 0.0))
        assertFalse(LocalDetectionTap.isOnGroundFrame(1, 0.0, 3.5))
        assertFalse(LocalDetectionTap.isOnGroundFrame(null, 0.0, 0.0))
    }

    @Test fun tap_isNoOpWithoutSink_andSwallowsSinkErrors() {
        LocalDetectionTap.sink = null
        LocalDetectionTap.onLocalDetection("A", 41.5, -81.7, 10.0, 1.0, 0.0, null, null, 2, true)
        LocalDetectionTap.sink = { throw IllegalStateException("boom") }
        try {
            LocalDetectionTap.onLocalDetection("A", 41.5, -81.7, 10.0, 1.0, 0.0, null, null, 2, true)
        } finally {
            LocalDetectionTap.sink = null
        }
    }

    @Test fun tap_buildsLocalObservation() {
        var got: DroneObservation? = null
        LocalDetectionTap.sink = { got = it }
        try {
            LocalDetectionTap.onLocalDetection("A", 41.5, -81.7, 2.0, 0.1, 10.0, 41.4, -81.6, 1, false)
        } finally {
            LocalDetectionTap.sink = null
        }
        val o = got!!
        assertEquals(DroneSource.LOCAL_BLE, o.source)
        assertEquals(AltitudeKind.HEIGHT, o.altitudeKind)
        assertTrue(o.onGround)
        assertFalse(o.kinematicsReliable)
    }
}

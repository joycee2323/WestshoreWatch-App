package com.westshoredrone.watch

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

// Same cases as test/odidParser.test.mjs (the TypeScript parser) — keep the two
// case lists identical so OdidParser.kt and odidParser.ts cannot drift.
// Run: ./gradlew :app:testDebugUnitTest --tests '*OdidParserTest*'
// (pure Kotlin + JUnit; no Android framework classes are touched).
class OdidParserTest {

    private data class Loc(
        val status: Int = 1, val heightType: Int = 0, val b1low: Int = 0, val dir: Int = 0,
        val speedRaw: Int = 0, val vspeedRaw: Int = 0,
        val latE7: Int = 414611922, val lonE7: Int = -819237012,
        val geoRaw: Int = 2358, val heightRaw: Int = 1998, val ts: Int = 1234,
    )

    // One 25-byte Location message (X1/M1 relay layout for bytes 1-3; status,
    // vertical speed and height are at the same positions in every layout).
    private fun location(l: Loc = Loc()): ByteArray {
        val b = ByteBuffer.allocate(25).order(ByteOrder.LITTLE_ENDIAN)
        b.put(0, 0x12.toByte())
        b.put(1, ((l.status shl 4) or (l.heightType shl 2) or l.b1low).toByte())
        b.put(2, l.dir.toByte())
        b.put(3, l.speedRaw.toByte())
        b.put(4, l.vspeedRaw.toByte())
        b.putInt(5, l.latE7)
        b.putInt(9, l.lonE7)
        b.putShort(13, l.geoRaw.toShort())
        b.putShort(15, l.geoRaw.toShort())
        b.putShort(17, l.heightRaw.toShort())
        b.putShort(21, l.ts.toShort())
        return b.array()
    }

    private fun basicId(uasId: String): ByteArray {
        val m = ByteArray(25)
        m[0] = 0x02; m[1] = 0x12
        uasId.forEachIndexed { i, c -> m[2 + i] = c.code.toByte() }
        return m
    }

    private fun serviceData(msg: ByteArray): ByteArray = byteArrayOf(0x0D, 7) + msg

    private fun pack(vararg msgs: ByteArray): ByteArray {
        var p = byteArrayOf(0xF2.toByte(), msgs.size.toByte())
        for (m in msgs) p += m
        return p
    }

    private fun parse(msg: ByteArray) = OdidParser.parseServiceData(serviceData(msg))!!

    // name, Location fields, expected (field -> value; null = unknown/invalid)
    private val cases: List<Triple<String, Loc, Map<String, Any?>>> = listOf(
        Triple("decoded docked Skydio frame", Loc(),
            mapOf("status" to 1, "height" to -1.0, "heightType" to 0, "speedVert" to 0.0, "altGeo" to 179.0)),
        Triple("height raw 0 (-1000 m) is invalid", Loc(heightRaw = 0), mapOf("height" to null)),
        Triple("geodetic altitude raw 0 (-1000 m) is invalid", Loc(geoRaw = 0), mapOf("altGeo" to null)),
        Triple("height raw 1 (-999.5 m) is a value", Loc(heightRaw = 1), mapOf("height" to -999.5)),
        Triple("height 30 m", Loc(heightRaw = 2060), mapOf("height" to 30.0)),
        Triple("vertical speed 63 m/s is invalid", Loc(vspeedRaw = 126), mapOf("speedVert" to null)),
        Triple("vertical speed -63 m/s is invalid", Loc(vspeedRaw = -126), mapOf("speedVert" to null)),
        Triple("vertical speed 63.5 m/s (raw 127) is invalid", Loc(vspeedRaw = 127), mapOf("speedVert" to null)),
        Triple("vertical speed -64 m/s (raw -128) is invalid", Loc(vspeedRaw = -128), mapOf("speedVert" to null)),
        Triple("vertical speed +62 m/s is the max valid", Loc(vspeedRaw = 124), mapOf("speedVert" to 62.0)),
        Triple("vertical speed -1.5 m/s (descending)", Loc(vspeedRaw = -3), mapOf("speedVert" to -1.5)),
        Triple("status 0 (undeclared)", Loc(status = 0), mapOf("status" to 0)),
        Triple("status 2 (airborne)", Loc(status = 2), mapOf("status" to 2)),
        Triple("status 3 (emergency)", Loc(status = 3), mapOf("status" to 3)),
        Triple("status 5 (reserved) is unknown", Loc(status = 5), mapOf("status" to null)),
        Triple("status 15 (reserved) is unknown", Loc(status = 15), mapOf("status" to null)),
        Triple("height type 1 (above ground) does not disturb status", Loc(heightType = 1),
            mapOf("status" to 1, "heightType" to 1)),
    )

    private fun field(r: OdidParser.Result, k: String): Any? = when (k) {
        "status" -> r.status
        "height" -> r.height
        "heightType" -> r.heightType
        "speedVert" -> r.speedVert
        "altGeo" -> r.altGeo
        else -> error("unknown field $k")
    }

    @Test
    fun locationCases() {
        for ((name, loc, expected) in cases) {
            val r = parse(location(loc))
            assertTrue("$name: hasLocation", r.hasLocation)
            for ((k, v) in expected) {
                if (v == null) assertNull("$name: $k should be unknown", field(r, k))
                else assertEquals("$name: $k", v, field(r, k))
            }
        }
    }

    @Test
    fun skydioPositionSpeedTimestampUnchanged() {
        val r = parse(location())
        assertEquals(41.4611922, r.lat!!, 0.0)
        assertEquals(-81.9237012, r.lon!!, 0.0)
        assertEquals(0.0, r.speedHoriz!!, 0.0)
        assertEquals(1234, r.odidTimestamp)
    }

    @Test
    fun existingSpeedAndHeadingDecodingUnchanged() {
        // X1/M1 relay layout: byte 1 bit 0 = E/W segment, byte 2 = direction<<1 | multiplier.
        val r = parse(location(Loc(b1low = 1, dir = (45 shl 1), speedRaw = 20)))
        assertEquals(225.0, r.heading!!, 0.0)
        assertEquals(5.0, r.speedHoriz!!, 0.0)
        val fast = parse(location(Loc(dir = (10 shl 1) or 1, speedRaw = 4)))
        assertEquals(10.0, fast.heading!!, 0.0)
        assertEquals(4 * 0.75 + 63.75, fast.speedHoriz!!, 0.0)
    }

    @Test
    fun packCarriesStatusHeightVerticalSpeed() {
        val r = parse(pack(basicId("1668BR40FA0098ER"), location(Loc(vspeedRaw = 1))))
        assertEquals(0xF, r.msgType)
        assertEquals("1668BR40FA0098ER", r.uasId)
        assertEquals(1, r.status)
        assertEquals(-1.0, r.height!!, 0.0)
        assertEquals(0.5, r.speedVert!!, 0.0)
    }
}

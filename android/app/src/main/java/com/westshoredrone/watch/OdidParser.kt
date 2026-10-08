package com.westshoredrone.watch

// Mirrors src/services/odidParser.ts. Parses ASTM F3411-22a Remote ID
// broadcasts delivered via the FFFA service-data field of a BLE advertisement.
object OdidParser {

    private const val ODID_APP_CODE = 0x0D

    const val OP_STATUS_AIRBORNE = 2

    // ASTM F3411 / opendroneid "invalid / unknown" encodings for the Location
    // message. A field carrying one of these is decoded to null (unknown) —
    // never a bogus number — so the backend's grounded rules fail open on it.
    //   status      4..15 reserved           → null
    //   altitudes   raw 0 = -1000 m          → null (decoded <= -999.75)
    //   height      raw 0 = -1000 m          → null
    //   vert speed  63 m/s (|v| > 62 m/s)    → null
    const val OP_STATUS_MAX_VALID = 3
    const val ALT_INVALID_MAX_M = -999.75
    const val VSPEED_MAX_VALID_MPS = 62.0

    data class Result(
        val msgType: Int? = null,
        val hasBasicId: Boolean = false,
        val hasLocation: Boolean = false,
        val hasSystem: Boolean = false,
        val uasId: String? = null,
        val lat: Double? = null,
        val lon: Double? = null,
        val altGeo: Double? = null,
        val speedHoriz: Double? = null,
        val heading: Double? = null,
        val status: Int? = null,
        // Location byte 17-18: height in metres (raw * 0.5 - 1000), relative
        // to heightType. null = unknown/invalid.
        val height: Double? = null,
        // Location byte 1 bit 2: 0 = above takeoff, 1 = above ground (AGL).
        // X1/M1 relayed frames always carry 0 (the firmware re-encoder does not
        // forward it). Parsed for completeness; not uploaded.
        val heightType: Int? = null,
        // Location byte 4: signed vertical speed, raw * 0.5 m/s, positive up.
        // null = unknown/invalid.
        val speedVert: Double? = null,
        val opLat: Double? = null,
        val opLon: Double? = null,
        // ASTM F3411-22a Location message bytes 21-22 (uint16 LE):
        // deciseconds since the most recent UTC hour, range 0-36000.
        // Drone-self-reported; advances every frame on a real airborne
        // drone, stays constant in firmware cached re-broadcasts. The
        // backend's stale-frame gate compares this to the last stored
        // value to suppress phantom POSTs. See migration 052 and
        // routes/nodes.js gate site.
        val odidTimestamp: Int? = null,
    ) {
        fun merge(other: Result): Result = Result(
            msgType = other.msgType ?: this.msgType,
            hasBasicId = other.hasBasicId || this.hasBasicId,
            hasLocation = other.hasLocation || this.hasLocation,
            hasSystem = other.hasSystem || this.hasSystem,
            uasId = other.uasId ?: this.uasId,
            lat = other.lat ?: this.lat,
            lon = other.lon ?: this.lon,
            altGeo = other.altGeo ?: this.altGeo,
            speedHoriz = other.speedHoriz ?: this.speedHoriz,
            heading = other.heading ?: this.heading,
            status = other.status ?: this.status,
            height = other.height ?: this.height,
            heightType = other.heightType ?: this.heightType,
            speedVert = other.speedVert ?: this.speedVert,
            opLat = other.opLat ?: this.opLat,
            opLon = other.opLon ?: this.opLon,
            odidTimestamp = other.odidTimestamp ?: this.odidTimestamp,
        )
    }

    fun parseServiceData(bytes: ByteArray?): Result? {
        if (bytes == null || bytes.size < 27) return null
        if ((bytes[0].toInt() and 0xFF) != ODID_APP_CODE) return null
        // Skip app code + counter, then 25-byte message(s) follow.
        val msg = bytes.copyOfRange(2, bytes.size)
        return parseMessage(msg)
    }

    private fun parseMessage(msg: ByteArray): Result {
        if (msg.isEmpty()) return Result()
        val msgType = (msg[0].toInt() ushr 4) and 0x0F
        return when (msgType) {
            0 -> parseBasicId(msg, msgType)
            1 -> parseLocation(msg, msgType)
            4 -> parseSystem(msg, msgType)
            0xF -> parsePack(msg, msgType)
            else -> Result(msgType = msgType)
        }
    }

    private fun parseBasicId(msg: ByteArray, msgType: Int): Result {
        val end = (msg.size).coerceAtMost(22)
        val sb = StringBuilder()
        for (i in 2 until end) {
            val b = msg[i].toInt() and 0xFF
            if (b == 0) break
            sb.append(b.toChar())
        }
        val uasId = if (sb.isNotEmpty()) sb.toString() else null
        return Result(msgType = msgType, hasBasicId = true, uasId = uasId)
    }

    private fun parseLocation(msg: ByteArray, msgType: Int): Result {
        if (msg.size < 25) return Result(msgType = msgType)
        val statusRaw = (msg[1].toInt() ushr 4) and 0x0F
        val status = if (statusRaw <= OP_STATUS_MAX_VALID) statusRaw else null
        val heightType = (msg[1].toInt() ushr 2) and 0x01
        // Byte 4 is a signed int8 (Kotlin Byte.toInt() sign-extends).
        val vspeed = msg[4].toInt() * 0.5
        val speedVert = if (kotlin.math.abs(vspeed) <= VSPEED_MAX_VALID_MPS) vspeed else null
        val ewSeg = msg[1].toInt() and 0x01
        val dirMod = (msg[2].toInt() ushr 1) and 0x7F
        val speedMult = msg[2].toInt() and 0x01
        val speedRaw = msg[3].toInt() and 0xFF

        val latRaw = readInt32LE(msg, 5)
        val lonRaw = readInt32LE(msg, 9)
        val altGeoRaw = readUInt16LE(msg, 15)
        val heightRaw = readUInt16LE(msg, 17)
        val tsRaw = readUInt16LE(msg, 21)

        val lat = latRaw / 1e7
        val lon = lonRaw / 1e7
        val altGeoM = (altGeoRaw * 0.5) - 1000.0
        val altGeo = if (altGeoM > ALT_INVALID_MAX_M) altGeoM else null
        val heightM = (heightRaw * 0.5) - 1000.0
        val height = if (heightM > ALT_INVALID_MAX_M) heightM else null
        val speedHoriz = if (speedMult == 1) (speedRaw * 0.75 + 63.75) else (speedRaw * 0.25)
        val heading = (dirMod + (ewSeg * 180)).toDouble()

        if (lat == 0.0 && lon == 0.0) return Result(msgType = msgType, hasLocation = false)

        return Result(
            msgType = msgType,
            hasLocation = true,
            lat = lat,
            lon = lon,
            altGeo = altGeo,
            speedHoriz = speedHoriz,
            heading = heading,
            status = status,
            height = height,
            heightType = heightType,
            speedVert = speedVert,
            odidTimestamp = tsRaw,
        )
    }

    private fun parseSystem(msg: ByteArray, msgType: Int): Result {
        if (msg.size < 25) return Result(msgType = msgType)
        val opLat = readInt32LE(msg, 2) / 1e7
        val opLon = readInt32LE(msg, 6) / 1e7
        if (opLat == 0.0 && opLon == 0.0) return Result(msgType = msgType, hasSystem = false)
        return Result(msgType = msgType, hasSystem = true, opLat = opLat, opLon = opLon)
    }

    private fun parsePack(data: ByteArray, msgType: Int): Result {
        if (data.size < 2) return Result(msgType = msgType)
        val msgCount = data[1].toInt() and 0x1F
        var acc = Result()
        for (i in 0 until msgCount) {
            val offset = 2 + i * 25
            if (offset + 25 > data.size) break
            val sub = data.copyOfRange(offset, offset + 25)
            acc = acc.merge(parseMessage(sub))
        }
        return acc.copy(msgType = msgType)
    }

    private fun readInt32LE(buf: ByteArray, offset: Int): Int {
        return (buf[offset].toInt() and 0xFF) or
            ((buf[offset + 1].toInt() and 0xFF) shl 8) or
            ((buf[offset + 2].toInt() and 0xFF) shl 16) or
            ((buf[offset + 3].toInt() and 0xFF) shl 24)
    }

    private fun readUInt16LE(buf: ByteArray, offset: Int): Int {
        return (buf[offset].toInt() and 0xFF) or
            ((buf[offset + 1].toInt() and 0xFF) shl 8)
    }
}

package com.westshoredrone.watch

// Mirrors src/services/odidParser.ts. Parses ASTM F3411-22a Remote ID
// broadcasts delivered via the FFFA service-data field of a BLE advertisement.
object OdidParser {

    private const val ODID_APP_CODE = 0x0D

    const val OP_STATUS_AIRBORNE = 2

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
        val opLat: Double? = null,
        val opLon: Double? = null,
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
            opLat = other.opLat ?: this.opLat,
            opLon = other.opLon ?: this.opLon,
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
        val status = (msg[1].toInt() ushr 4) and 0x0F
        val ewSeg = msg[1].toInt() and 0x01
        val dirMod = (msg[2].toInt() ushr 1) and 0x7F
        val speedMult = msg[2].toInt() and 0x01
        val speedRaw = msg[3].toInt() and 0xFF

        val latRaw = readInt32LE(msg, 5)
        val lonRaw = readInt32LE(msg, 9)
        val altGeoRaw = readUInt16LE(msg, 15)

        val lat = latRaw / 1e7
        val lon = lonRaw / 1e7
        val altGeo = (altGeoRaw * 0.5) - 1000.0
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

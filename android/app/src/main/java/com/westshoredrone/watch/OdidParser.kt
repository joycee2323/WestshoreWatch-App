package com.westshoredrone.watch

// Mirrors src/services/odidParser.ts. Parses ASTM F3411-22a Remote ID
// broadcasts delivered via the FFFA service-data field of a BLE advertisement.
object OdidParser {

    private const val ODID_APP_CODE = 0x0D

    const val OP_STATUS_AIRBORNE = 2

    // ASTM F3411 / opendroneid "invalid / unknown" encodings for the Location
    // message. A field carrying one of these is decoded to null (unknown) —
    // never a bogus number — so the backend's grounded rules fail open on it.
    //   status      5..15 reserved           → null (4 = RID system failure, valid)
    //   altitudes   raw 0 = -1000 m          → null (decoded <= -999.75)
    //   height      raw 0 = -1000 m          → null
    //   vert speed  63 m/s (|v| > 62 m/s)    → null
    const val OP_STATUS_MAX_VALID = 4

    // Relay format 2 — WestshoreWatch-Firmware WSW-Firmware/main/odid_encoder.h
    // (tag x1m1-1.4-westshore). Pack byte 1 = (rf << 5) | count; message 4 is
    // the drone's own ASTM Location with type nibble MSG_SPEC_LOCATION. rf is
    // read from the Pack itself; handle-0 frames stay legacy. Mirrors
    // odidParser.ts / WSWOdidParser.swift.
    const val RELAY_FORMAT_SPEC = 2
    const val MSG_SPEC_LOCATION = 0xE
    const val DECODER_SPEC = "odid-spec-1"
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
        // Relay format 2 only (see RELAY_FORMAT_SPEC): speedHoriz / heading
        // came from the drone's spec Location; decoder + locRaw are uploaded.
        // null = legacy decode (no decoder field is sent).
        val decoder: String? = null,
        val locRaw: String? = null,
        val relayFormat: Int? = null,
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
            decoder = other.decoder ?: this.decoder,
            locRaw = other.locRaw ?: this.locRaw,
            relayFormat = other.relayFormat ?: this.relayFormat,
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
        val relayFormat = ((data[1].toInt() and 0xFF) ushr 5) and 0x07
        var acc = Result()
        var spec: ByteArray? = null
        for (i in 0 until msgCount) {
            val offset = 2 + i * 25
            if (offset + 25 > data.size) break
            val sub = data.copyOfRange(offset, offset + 25)
            if (((sub[0].toInt() ushr 4) and 0x0F) == MSG_SPEC_LOCATION) { spec = sub; continue }
            acc = acc.merge(parseMessage(sub))
        }
        if (relayFormat == RELAY_FORMAT_SPEC && spec != null && acc.hasLocation) {
            val k = parseSpecLocationKinematics(spec)
            val original = spec.copyOf()
            original[0] = ((0x1 shl 4) or (spec[0].toInt() and 0x0F)).toByte()
            acc = acc.copy(
                speedHoriz = k.speedHoriz, heading = k.heading,
                decoder = DECODER_SPEC, locRaw = toHex(original), relayFormat = relayFormat,
            )
        }
        return acc.copy(msgType = msgType)
    }

    data class SpecKinematics(val heading: Double?, val speedHoriz: Double?, val lat: Double, val lon: Double)

    // ASTM F3411 / opendroneid Location bytes 1-4: byte 1 bit 0 SpeedMult,
    // bit 1 EWDirection; byte 2 = direction 0..179 (+180 with EW), >= 180 =
    // unknown (361 is written as 181 + EW); speed = mult ? raw*0.75 + 63.75 :
    // raw*0.25, raw 255 with mult = unknown. Lat/lon as doubles.
    fun parseSpecLocationKinematics(msg: ByteArray): SpecKinematics {
        val b1 = msg[1].toInt() and 0xFF
        val mult = b1 and 0x01
        val ew = (b1 ushr 1) and 0x01
        val dir = msg[2].toInt() and 0xFF
        val raw = msg[3].toInt() and 0xFF
        val heading = if (dir >= 180) null else (dir + (if (ew == 1) 180 else 0)).toDouble()
        val speed = if (mult == 1 && raw == 255) null else if (mult == 1) raw * 0.75 + 63.75 else raw * 0.25
        return SpecKinematics(heading, speed, readInt32LE(msg, 5) / 1e7, readInt32LE(msg, 9) / 1e7)
    }

    private fun toHex(b: ByteArray): String {
        val sb = StringBuilder(b.size * 2)
        for (x in b) sb.append(String.format("%02x", x.toInt() and 0xFF))
        return sb.toString()
    }

    data class FirmwareTag(val version: String, val build: String?, val relayFormat: Int?)

    // 0x08FE identity advert payload (Android: manufacturer data WITHOUT the
    // company id): [MAC(6)][api_key ...][0x00]["fw=<ver>+<elf8>;rf=<n>"].
    // Firmware before the fw tag sends no 0x00 / tag -> null.
    fun parseFirmwareTag(payload: ByteArray?): FirmwareTag? {
        if (payload == null || payload.size <= 7) return null
        var sep = -1
        for (i in 6 until payload.size) if (payload[i].toInt() == 0) { sep = i; break }
        if (sep < 0 || sep + 1 >= payload.size) return null
        val tag = String(payload, sep + 1, payload.size - sep - 1, Charsets.US_ASCII)
        if (!tag.startsWith("fw=")) return null
        val parts = tag.substring(3).split(';')
        val verBuild = parts[0]
        val plus = verBuild.indexOf('+')
        val version = if (plus >= 0) verBuild.substring(0, plus) else verBuild
        val build = if (plus >= 0) verBuild.substring(plus + 1) else null
        val rf = parts.drop(1).firstOrNull { it.startsWith("rf=") }?.substring(3)?.toIntOrNull()
        if (version.isEmpty() || version.length > 50 || !version.all { it in ' '..'~' }) return null
        return FirmwareTag(version, build?.takeIf { it.isNotEmpty() }, rf)
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

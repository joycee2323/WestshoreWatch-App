package com.westshoredrone.watch.auto

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/**
 * Parses backend drone rows into [DroneObservation]s. The same row shape
 * arrives in two places:
 *  - WS `{type:"DRONE_UPDATE", drones:[row…]}` (RETURNING * from drone_detections)
 *  - REST `GET /api/detections/recent` (array of rows; DECIMAL columns as strings)
 * Fields used: uas_id, last_lat, last_lon, alt_agl_m, last_speed, last_heading,
 * op_lat, op_lon, last_seen (ISO-8601), nickname. HAE `last_altitude` is never
 * shown (the app's rule: live altitude is AGL only).
 */
object BackendParser {

    /** Rows of a DRONE_UPDATE message, or empty for any other message type. */
    fun parseWsMessage(text: String, receivedAtMs: Long): List<DroneObservation> {
        val obj = runCatching { JSONObject(text) }.getOrNull() ?: return emptyList()
        if (obj.optString("type") != "DRONE_UPDATE") return emptyList()
        // A live DRONE_UPDATE is a fresh frame (the backend's stale-frame gate
        // never broadcasts re-broadcasts), so receive time is a fine
        // "last seen"; prefer the server's value when it's older.
        return parseRows(obj.optJSONArray("drones"), receivedAtMs)
    }

    fun messageType(text: String): String? =
        runCatching { JSONObject(text).optString("type") }.getOrNull()?.takeIf { it.isNotEmpty() }

    fun parseRestArray(text: String, nowMs: Long): List<DroneObservation> {
        val arr = runCatching { JSONArray(text) }.getOrNull() ?: return emptyList()
        return parseRows(arr, nowMs)
    }

    fun parseRows(arr: JSONArray?, nowMs: Long): List<DroneObservation> {
        if (arr == null) return emptyList()
        val out = ArrayList<DroneObservation>(arr.length())
        for (i in 0 until arr.length()) {
            val row = arr.optJSONObject(i) ?: continue
            parseRow(row, nowMs)?.let { out += it }
        }
        return out
    }

    fun parseRow(row: JSONObject, nowMs: Long): DroneObservation? {
        val uas = row.optString("uas_id", "").trim()
        if (uas.isEmpty()) return null
        val lat = num(row, "last_lat") ?: return null
        val lon = num(row, "last_lon") ?: return null
        if (!Geo.isValidCoordinate(lat, lon)) return null
        val serverSeen = parseIsoMs(str(row, "last_seen"))
        return DroneObservation(
            uasId = uas,
            nickname = str(row, "nickname")?.takeIf { it.isNotBlank() },
            lat = lat,
            lon = lon,
            altitudeM = num(row, "alt_agl_m"),
            altitudeKind = AltitudeKind.AGL,
            speedMps = num(row, "last_speed"),
            headingDeg = num(row, "last_heading"),
            opLat = num(row, "op_lat"),
            opLon = num(row, "op_lon"),
            observedAtMs = if (serverSeen != null) minOf(serverSeen, nowMs) else nowMs,
            onGround = false,
            source = DroneSource.BACKEND,
            // Absent on backends older than the kinematics display rule: those
            // didn't flag anything, so keep showing what they send.
            kinematicsReliable = if (row.has("kinematics_reliable") && !row.isNull("kinematics_reliable"))
                row.optBoolean("kinematics_reliable", true) else true,
        )
    }

    /** Numbers arrive as JSON numbers (WS) or strings (pg DECIMAL over REST). */
    private fun num(o: JSONObject, key: String): Double? {
        if (!o.has(key) || o.isNull(key)) return null
        val v = o.opt(key)
        val d = when (v) {
            is Number -> v.toDouble()
            is String -> v.trim().toDoubleOrNull()
            else -> null
        }
        return d?.takeIf { !it.isNaN() && !it.isInfinite() }
    }

    private fun str(o: JSONObject, key: String): String? =
        if (!o.has(key) || o.isNull(key)) null else o.optString(key, "").takeIf { it.isNotEmpty() }

    fun parseIsoMs(iso: String?): Long? {
        if (iso.isNullOrBlank()) return null
        return runCatching { Instant.parse(iso).toEpochMilli() }.getOrNull()
    }
}

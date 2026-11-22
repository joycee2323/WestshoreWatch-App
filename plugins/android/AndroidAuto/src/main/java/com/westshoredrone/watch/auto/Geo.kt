package com.westshoredrone.watch.auto

import java.util.Locale
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.roundToLong
import kotlin.math.sin
import kotlin.math.sqrt

/** Pure geo math + display formatting for the car screens. No Android dependencies. */
object Geo {
    private const val EARTH_RADIUS_M = 6_371_000.0
    private val CARDINALS = arrayOf("N", "NE", "E", "SE", "S", "SW", "W", "NW")

    /** Great-circle distance in meters (haversine). */
    fun distanceMeters(fromLat: Double, fromLon: Double, toLat: Double, toLon: Double): Double {
        val phi1 = Math.toRadians(fromLat)
        val phi2 = Math.toRadians(toLat)
        val dPhi = Math.toRadians(toLat - fromLat)
        val dLam = Math.toRadians(toLon - fromLon)
        val a = sin(dPhi / 2) * sin(dPhi / 2) +
            cos(phi1) * cos(phi2) * sin(dLam / 2) * sin(dLam / 2)
        return EARTH_RADIUS_M * 2 * atan2(sqrt(a), sqrt(1 - a))
    }

    /** Initial great-circle bearing from → to, true-north degrees in [0, 360). */
    fun bearingDeg(fromLat: Double, fromLon: Double, toLat: Double, toLon: Double): Double {
        val phi1 = Math.toRadians(fromLat)
        val phi2 = Math.toRadians(toLat)
        val dLam = Math.toRadians(toLon - fromLon)
        val y = sin(dLam) * cos(phi2)
        val x = cos(phi1) * sin(phi2) - sin(phi1) * cos(phi2) * cos(dLam)
        return (Math.toDegrees(atan2(y, x)) + 360.0) % 360.0
    }

    /** 8-point compass label for a bearing/heading in degrees (any range). */
    fun cardinal(deg: Double): String {
        val norm = ((deg % 360.0) + 360.0) % 360.0
        return CARDINALS[((norm + 22.5) / 45.0).toInt() % 8]
    }

    fun isValidCoordinate(lat: Double?, lon: Double?): Boolean {
        if (lat == null || lon == null) return false
        if (lat.isNaN() || lon.isNaN()) return false
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false
        // (0,0) is the ODID "no fix" value; the backend rejects it too.
        return !(lat == 0.0 && lon == 0.0)
    }

    /** `geo:` URI for CarContext.ACTION_NAVIGATE. Always '.' decimals, regardless of locale. */
    fun geoUri(lat: Double, lon: Double): String =
        String.format(Locale.US, "geo:%.6f,%.6f", lat, lon)
}

/** Unit of a [CarDistance]; mapped to androidx.car.app.model.Distance units by the UI layer. */
enum class DistanceUnit { FEET, MILES }

/** A value + unit pair the UI turns into a DistanceSpan. */
data class CarDistance(val value: Double, val unit: DistanceUnit)

/**
 * Imperial display formatting. Mirrors src/utils/units.ts in the phone app
 * (fmtAgl, fmtSpeed, fmtDistance) so the car and phone show the same numbers.
 */
object Fmt {
    private const val M_TO_FT = 3.28084
    private const val MS_TO_MPH = 2.23694
    private const val FT_PER_MILE = 5280.0

    /** Same rule as fmtAgl: AGL only, clamped at 0, "AGL n/a" when unknown. */
    fun agl(aglM: Double?): String {
        if (aglM == null || aglM.isNaN() || aglM.isInfinite()) return "AGL n/a"
        val ft = max(0L, (aglM * M_TO_FT).roundToLong())
        return "$ft ft AGL"
    }

    /** Height above takeoff reported by the drone itself (local BLE frames). */
    fun height(heightM: Double?): String {
        if (heightM == null || heightM.isNaN() || heightM.isInfinite()) return "Height n/a"
        val ft = max(0L, (heightM * M_TO_FT).roundToLong())
        return "$ft ft high"
    }

    fun altitude(altM: Double?, kind: AltitudeKind): String =
        if (kind == AltitudeKind.HEIGHT) height(altM) else agl(altM)

    /** Same rule as fmtSpeed: one decimal mph, "—" when unknown. */
    fun speed(mps: Double?): String {
        if (mps == null || mps.isNaN() || mps.isInfinite()) return "—"
        return String.format(Locale.US, "%.1f mph", mps * MS_TO_MPH)
    }

    /** Same rule as fmtDistance: whole feet under 1000 ft, else miles to 2 decimals. */
    fun distance(meters: Double?): String {
        if (meters == null || meters.isNaN() || meters.isInfinite()) return "—"
        val ft = meters * M_TO_FT
        return if (ft < 1000) "${ft.roundToLong()} ft"
        else String.format(Locale.US, "%.2f mi", ft / FT_PER_MILE)
    }

    /**
     * Value for a DistanceSpan: feet (rounded to 10) under 1000 ft, else miles
     * to one decimal. The host renders it in its own localized format.
     */
    fun carDistance(meters: Double): CarDistance {
        val ft = meters * M_TO_FT
        return if (ft < 1000) CarDistance(((ft / 10.0).roundToLong() * 10).toDouble(), DistanceUnit.FEET)
        else CarDistance(Math.round(ft / FT_PER_MILE * 10.0) / 10.0, DistanceUnit.MILES)
    }

    /** "NE (45°)" or "—". */
    fun heading(deg: Double?): String {
        if (deg == null || deg.isNaN() || deg.isInfinite()) return "—"
        val norm = ((deg % 360.0) + 360.0) % 360.0
        return "${Geo.cardinal(norm)} (${norm.roundToLong() % 360}°)"
    }

    /** "now", "8 s ago", "2 min ago". */
    fun age(ageMs: Long): String {
        val s = max(0L, ageMs) / 1000
        return when {
            s < 2 -> "now"
            s < 60 -> "$s s ago"
            else -> "${s / 60} min ago"
        }
    }
}

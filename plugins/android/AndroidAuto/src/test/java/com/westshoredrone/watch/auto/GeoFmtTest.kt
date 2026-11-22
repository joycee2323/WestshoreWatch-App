package com.westshoredrone.watch.auto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GeoFmtTest {
    @Test fun distance_oneDegreeLatitude_isAbout111km() {
        val d = Geo.distanceMeters(40.0, -82.0, 41.0, -82.0)
        assertEquals(111_195.0, d, 50.0)
    }

    @Test fun distance_samePoint_isZero() {
        assertEquals(0.0, Geo.distanceMeters(41.5, -81.7, 41.5, -81.7), 1e-9)
    }

    @Test fun bearing_cardinalDirections() {
        assertEquals(0.0, Geo.bearingDeg(41.0, -81.0, 41.1, -81.0), 0.01)
        assertEquals(90.0, Geo.bearingDeg(0.0, 0.0, 0.0, 0.1), 0.01)
        assertEquals(180.0, Geo.bearingDeg(41.1, -81.0, 41.0, -81.0), 0.01)
        assertEquals(270.0, Geo.bearingDeg(0.0, 0.1, 0.0, 0.0), 0.01)
    }

    @Test fun cardinal_boundariesAndWrap() {
        assertEquals("N", Geo.cardinal(0.0))
        assertEquals("N", Geo.cardinal(22.4))
        assertEquals("NE", Geo.cardinal(22.5))
        assertEquals("E", Geo.cardinal(90.0))
        assertEquals("SW", Geo.cardinal(225.0))
        assertEquals("NW", Geo.cardinal(337.4))
        assertEquals("N", Geo.cardinal(359.9))
        assertEquals("N", Geo.cardinal(360.0))
        assertEquals("W", Geo.cardinal(-90.0))
    }

    @Test fun validCoordinate_rejectsNoFixAndOutOfRange() {
        assertTrue(Geo.isValidCoordinate(41.5, -81.7))
        assertFalse(Geo.isValidCoordinate(0.0, 0.0))
        assertFalse(Geo.isValidCoordinate(null, -81.7))
        assertFalse(Geo.isValidCoordinate(91.0, 0.0))
        assertFalse(Geo.isValidCoordinate(41.0, 181.0))
        assertFalse(Geo.isValidCoordinate(Double.NaN, 1.0))
    }

    @Test fun geoUri_usesDotDecimalsInAnyLocale() {
        val prev = java.util.Locale.getDefault()
        try {
            java.util.Locale.setDefault(java.util.Locale.GERMANY)
            assertEquals("geo:41.499320,-81.694361", Geo.geoUri(41.49932, -81.694361))
        } finally {
            java.util.Locale.setDefault(prev)
        }
    }

    // Same cases as test/fmtAgl.test.mjs (phone) and the Wear AglTest.
    @Test fun agl_matchesPhoneFmtAgl() {
        assertEquals("120 ft AGL", Fmt.agl(36.576))
        assertEquals("0 ft AGL", Fmt.agl(0.0))
        assertEquals("0 ft AGL", Fmt.agl(-3.7))
        assertEquals("0 ft AGL", Fmt.agl(-0.1))
        assertEquals("1 ft AGL", Fmt.agl(0.1524))
        assertEquals("AGL n/a", Fmt.agl(null))
        assertEquals("AGL n/a", Fmt.agl(Double.NaN))
    }

    @Test fun height_formatsLocalBleHeight() {
        assertEquals("98 ft high", Fmt.height(30.0))
        assertEquals("Height n/a", Fmt.height(null))
        assertEquals("98 ft high", Fmt.altitude(30.0, AltitudeKind.HEIGHT))
        assertEquals("98 ft AGL", Fmt.altitude(30.0, AltitudeKind.AGL))
    }

    @Test fun speed_matchesPhoneFmtSpeed() {
        assertEquals("22.4 mph", Fmt.speed(10.0))
        assertEquals("0.0 mph", Fmt.speed(0.0))
        assertEquals("—", Fmt.speed(null))
    }

    @Test fun distance_matchesPhoneFmtDistance() {
        assertEquals("328 ft", Fmt.distance(100.0))
        assertEquals("999 ft", Fmt.distance(304.5))
        assertEquals("0.62 mi", Fmt.distance(1000.0))
        assertEquals("—", Fmt.distance(null))
    }

    @Test fun carDistance_feetUnder1000_thenMilesOneDecimal() {
        assertEquals(CarDistance(330.0, DistanceUnit.FEET), Fmt.carDistance(100.0))
        assertEquals(CarDistance(0.0, DistanceUnit.FEET), Fmt.carDistance(1.0))
        assertEquals(CarDistance(0.6, DistanceUnit.MILES), Fmt.carDistance(1000.0))
        assertEquals(CarDistance(6.2, DistanceUnit.MILES), Fmt.carDistance(10_000.0))
    }

    @Test fun heading_cardinalAndDegrees() {
        assertEquals("NE (45°)", Fmt.heading(45.0))
        assertEquals("N (0°)", Fmt.heading(359.7))
        assertEquals("W (270°)", Fmt.heading(-90.0))
        assertEquals("—", Fmt.heading(null))
    }

    @Test fun age_buckets() {
        assertEquals("now", Fmt.age(0))
        assertEquals("now", Fmt.age(1_999))
        assertEquals("2 s ago", Fmt.age(2_000))
        assertEquals("59 s ago", Fmt.age(59_999))
        assertEquals("1 min ago", Fmt.age(60_000))
        assertEquals("now", Fmt.age(-5_000))
    }
}

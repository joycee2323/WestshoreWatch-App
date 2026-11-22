package com.westshoredrone.watch.auto

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocationFreshnessTest {
    private val ms = 1_000_000L
    private val max = PhoneLocation.LAST_KNOWN_MAX_AGE_MS

    @Test fun `fresh and boundary fixes are accepted`() {
        val now = 10_000_000 * ms
        assertTrue(LocationFreshness.isRecent(now, now, max))
        assertTrue(LocationFreshness.isRecent(now - 60_000 * ms, now, max))
        assertTrue(LocationFreshness.isRecent(now - max * ms, now, max))
    }

    @Test fun `older than five minutes is rejected`() {
        val now = 10_000_000 * ms
        assertFalse(LocationFreshness.isRecent(now - (max + 1) * ms, now, max))
        assertFalse(LocationFreshness.isRecent(now - 3 * 3_600_000 * ms, now, max))
    }

    @Test fun `a fix from the future (clock oddity) is rejected`() {
        val now = 10_000_000 * ms
        assertFalse(LocationFreshness.isRecent(now + 1, now, max))
    }

    @Test fun `five minute window`() {
        assertTrue(max == 300_000L)
    }
}

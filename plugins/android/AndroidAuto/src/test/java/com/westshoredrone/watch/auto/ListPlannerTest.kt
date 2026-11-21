package com.westshoredrone.watch.auto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ListPlannerTest {
    private val origin = LatLon(41.5, -81.7)

    private fun drone(
        id: String, northM: Double, firstSeen: Long = 0, op: Boolean = false, nickname: String? = null,
    ): TrackedDrone {
        val lat = origin.lat + northM / 111_195.0
        return TrackedDrone(
            uasId = id, nickname = nickname, lat = lat, lon = origin.lon, altitudeM = 30.0,
            altitudeKind = AltitudeKind.AGL, speedMps = 1.0, headingDeg = 0.0,
            opLat = if (op) lat + 0.001 else null, opLon = if (op) origin.lon else null,
            firstSeenMs = firstSeen, lastSeenMs = firstSeen, groundedSinceMs = null,
        )
    }

    private fun keys(rows: List<RowSpec>) = rows.map { it.key }

    @Test fun plan_sortsNearestFirst() {
        val rows = ListPlanner.plan(listOf(drone("far", 900.0), drone("near", 100.0)), origin, 6, null)
        assertEquals(listOf("d:near", "d:far"), keys(rows))
        assertEquals(100.0, rows[0].distanceM!!, 1.0)
        assertEquals(0.0, rows[0].bearingDeg!!, 0.5)
    }

    @Test fun plan_withoutLocation_sortsByFirstSeen_andHasNoDistance() {
        val rows = ListPlanner.plan(listOf(drone("b", 100.0, firstSeen = 5), drone("a", 900.0, firstSeen = 1)), null, 6, null)
        assertEquals(listOf("d:a", "d:b"), keys(rows))
        assertNull(rows[0].distanceM)
    }

    @Test fun plan_trimsToRowLimit_keepingNearest() {
        val drones = (1..8).map { drone("d$it", it * 100.0) }
        val rows = ListPlanner.plan(drones, origin, 6, null)
        assertEquals(6, rows.size)
        assertEquals("d:d1", rows.first().key)
        assertEquals("d:d6", rows.last().key)
    }

    @Test fun plan_operatorsFillRemainingRows_afterAllDrones() {
        val rows = ListPlanner.plan(listOf(drone("a", 100.0, op = true), drone("b", 200.0, op = true)), origin, 3, null)
        assertEquals(listOf("d:a", "d:b", "o:a"), keys(rows))
        assertTrue(rows[2].isOperator)
        assertEquals("Operator · a", rows[2].title)
    }

    @Test fun plan_noOperatorRowsWhenDronesFillTheLimit() {
        val rows = ListPlanner.plan(listOf(drone("a", 100.0, op = true), drone("b", 200.0)), origin, 2, null)
        assertEquals(listOf("d:a", "d:b"), keys(rows))
    }

    @Test fun plan_stickyOrder_whenSameSetEvenIfDistancesSwap() {
        val rows = ListPlanner.plan(listOf(drone("a", 500.0), drone("b", 100.0)), origin, 6, listOf("a", "b"))
        assertEquals(listOf("d:a", "d:b"), keys(rows))
    }

    @Test fun plan_resortsWhenSetChanges() {
        val rows = ListPlanner.plan(
            listOf(drone("a", 500.0), drone("b", 100.0), drone("c", 50.0)), origin, 6, listOf("a", "b"),
        )
        assertEquals(listOf("d:c", "d:b", "d:a"), keys(rows))
    }

    @Test fun plan_titleUsesNicknameWhenKnown() {
        val rows = ListPlanner.plan(listOf(drone("SN123", 100.0, nickname = "Fire Dept")), origin, 6, null)
        assertEquals("Fire Dept", rows[0].title)
    }

    @Test fun plan_emptyOrZeroLimit() {
        assertTrue(ListPlanner.plan(emptyList(), origin, 6, null).isEmpty())
        assertTrue(ListPlanner.plan(listOf(drone("a", 1.0)), origin, 0, null).isEmpty())
    }

    // ---- ListRefreshPolicy ----

    private fun spec(id: String, title: String = id) = RowSpec("d:$id", id, false, title, 41.5, -81.7, 10.0, 0.0)

    @Test fun policy_firstDecision_showsEverything() {
        val p = ListRefreshPolicy()
        val d = p.decide(listOf(spec("a")), mapOf("d:a" to spec("a")), appDrivenRefresh = false)
        assertEquals(listOf("d:a"), d.rows.map { it.spec.key })
        assertFalse(d.pending)
        assertFalse(d.counted)
    }

    @Test fun policy_sameTitles_isFreeRefresh_withFreshValues() {
        val p = ListRefreshPolicy()
        p.decide(listOf(spec("a")), emptyMap(), false)
        val moved = spec("a").copy(distanceM = 99.0)
        val d = p.decide(listOf(moved), mapOf("d:a" to moved), false)
        assertEquals(99.0, d.rows[0].spec.distanceM!!, 0.0)
        assertFalse(d.counted)
        assertFalse(d.pending)
        assertEquals(2, p.remainingBudget())
    }

    @Test fun policy_newDrone_spendsBudget_thenFreezesWithPending() {
        val p = ListRefreshPolicy(countedBudget = 1)
        p.decide(emptyList(), emptyMap(), false)
        val d1 = p.decide(listOf(spec("a")), mapOf("d:a" to spec("a")), false)
        assertTrue(d1.counted)
        assertEquals(0, p.remainingBudget())
        val desired = listOf(spec("a"), spec("b"))
        val d2 = p.decide(desired, desired.associateBy { it.key }, false)
        assertTrue(d2.pending)
        assertFalse(d2.counted)
        assertEquals(listOf("d:a"), d2.rows.map { it.spec.key })
    }

    @Test fun policy_vanishedDrone_isKeptAsLost_withoutSpendingBudget() {
        val p = ListRefreshPolicy()
        p.decide(listOf(spec("a"), spec("b")), emptyMap(), false)
        val d = p.decide(listOf(spec("a")), mapOf("d:a" to spec("a")), false)
        assertEquals(listOf(false, true), d.rows.map { it.lost })
        assertTrue(d.pending)
        assertEquals(2, p.remainingBudget())
    }

    @Test fun policy_frozenRowsKeepPreviousTitles() {
        val p = ListRefreshPolicy(countedBudget = 0)
        p.decide(listOf(spec("a", "SN1")), emptyMap(), false)
        val renamed = spec("a", "Nickname")
        val d = p.decide(listOf(renamed, spec("b")), mapOf("d:a" to renamed, "d:b" to spec("b")), false)
        assertEquals("SN1", d.rows[0].spec.title)
        assertTrue(d.pending)
    }

    @Test fun policy_rebase_appliesPendingForFree() {
        val p = ListRefreshPolicy(countedBudget = 0)
        p.decide(listOf(spec("a")), emptyMap(), false)
        val desired = listOf(spec("a"), spec("b"))
        assertTrue(p.decide(desired, desired.associateBy { it.key }, false).pending)
        p.rebase()
        val d = p.decide(desired, desired.associateBy { it.key }, false)
        assertEquals(listOf("d:a", "d:b"), d.rows.map { it.spec.key })
        assertFalse(d.pending)
        assertFalse(d.counted)
    }

    @Test fun policy_appDrivenHost_alwaysShowsCurrentRows() {
        val p = ListRefreshPolicy(countedBudget = 0)
        p.decide(listOf(spec("a")), emptyMap(), true)
        val d = p.decide(listOf(spec("b"), spec("c")), emptyMap(), true)
        assertEquals(listOf("d:b", "d:c"), d.rows.map { it.spec.key })
        assertFalse(d.pending)
        assertFalse(d.counted)
    }

    @Test fun policy_shownDroneOrder_excludesOperators() {
        val p = ListRefreshPolicy()
        val op = RowSpec("o:a", "a", true, "Operator · a", 41.5, -81.7, 10.0, 0.0)
        p.decide(listOf(spec("a"), op), emptyMap(), false)
        assertEquals(listOf("a"), p.shownDroneOrder())
    }

    // ---- RefreshThrottle ----

    @Test fun throttle_firstUpdateImmediate_thenSpacedBy3s() {
        val t = RefreshThrottle()
        assertEquals(0L, t.delayUntilAllowed(10_000))
        t.markSent(10_000)
        assertEquals(3_000L, t.delayUntilAllowed(10_000))
        assertEquals(1_000L, t.delayUntilAllowed(12_000))
        assertEquals(0L, t.delayUntilAllowed(13_000))
        assertEquals(0L, t.delayUntilAllowed(20_000))
    }

    // ---- NewDroneAlerter ----

    @Test fun alerter_singleAndBatchedMessages() {
        val a = NewDroneAlerter()
        a.onNewDrone("Blue")
        assertEquals("New drone: Blue", a.poll(0, needsRefreshTap = false))
        assertNull(a.poll(1, false))
        a.onNewDrone("X"); a.onNewDrone("Y"); a.onNewDrone("X")
        assertNull("rate-limited inside 10 s", a.poll(5_000, false))
        assertEquals("2 new drones detected. Tap refresh to show.", a.poll(10_000, needsRefreshTap = true))
        assertFalse(a.hasPending())
    }
}

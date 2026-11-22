package com.westshoredrone.watch.auto

import androidx.car.app.model.DistanceSpan
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.PaneTemplate
import androidx.car.app.model.PlaceListMapTemplate
import androidx.car.app.model.Row
import androidx.car.app.testing.TestCarContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Builds the real templates under Robolectric so the Car App Library's own
 * validation runs (DistanceSpan-on-every-non-browsable-row, row text limits,
 * marker label length, loading-XOR-list, pane rows/actions). A violation would
 * be an IllegalArgumentException at runtime on the head unit.
 */
@RunWith(RobolectricTestRunner::class)
// Plain Application: the real MainApplication would boot React Native (SoLoader).
@Config(sdk = [34], application = android.app.Application::class)
class ScreenTemplatesTest {
    private lateinit var carContext: TestCarContext
    private lateinit var controller: AutoController
    private val origin = LatLon(41.5, -81.7)

    @Before fun setUp() {
        carContext = TestCarContext.createCarContext(RuntimeEnvironment.getApplication())
        controller = AutoController(carContext)
    }

    private fun obs(id: String, northM: Double, op: Boolean = false, nickname: String? = null) = DroneObservation(
        uasId = id, nickname = nickname, lat = origin.lat + northM / 111_195.0, lon = origin.lon,
        altitudeM = 30.0, altitudeKind = AltitudeKind.AGL, speedMps = 5.0, headingDeg = 90.0,
        opLat = if (op) origin.lat + 0.002 else null, opLon = if (op) origin.lon + 0.002 else null,
        observedAtMs = System.currentTimeMillis(), onGround = false, source = DroneSource.BACKEND,
    )

    @Test fun list_beforeData_isLoading() {
        val t = DroneListScreen(carContext, controller).onGetTemplate() as PlaceListMapTemplate
        assertTrue(t.isLoading)
    }

    @Test fun list_emptyState_showsNoDronesMessage() {
        controller.ingestForTest(emptyList())
        val t = DroneListScreen(carContext, controller).onGetTemplate() as PlaceListMapTemplate
        assertFalse(t.isLoading)
        assertEquals(0, t.itemList!!.items.size)
        assertTrue(t.itemList!!.noItemsMessage!!.toString().startsWith("No drones detected"))
    }

    @Test fun list_withLocation_everyRowHasDistance_andOperatorsFollowDrones() {
        controller.originOverride = origin
        controller.ingestForTest(listOf(obs("FAR", 900.0), obs("NEAR", 100.0, op = true, nickname = "Blue")))
        val t = DroneListScreen(carContext, controller).onGetTemplate() as PlaceListMapTemplate
        val rows = t.itemList!!.items.map { it as Row }
        assertEquals(listOf("Blue", "FAR", "Operator · Blue"), rows.map { it.title.toString() })
        for (r in rows) {
            assertFalse(r.isBrowsable)
            assertTrue("row ${r.title} needs a DistanceSpan", r.texts[0].spans.any { it.carSpan is DistanceSpan })
            assertTrue(r.metadata?.place != null)
        }
    }

    @Test fun list_withoutLocation_rowsAreBrowsable() {
        controller.ingestForTest(listOf(obs("A", 100.0)))
        val t = DroneListScreen(carContext, controller).onGetTemplate() as PlaceListMapTemplate
        val row = t.itemList!!.items.single() as Row
        assertTrue(row.isBrowsable)
    }

    @Test fun list_manyDrones_staysWithinRowLimit() {
        controller.originOverride = origin
        controller.ingestForTest((1..10).map { obs("D$it", it * 50.0, op = true) })
        val t = DroneListScreen(carContext, controller).onGetTemplate() as PlaceListMapTemplate
        assertEquals(6, t.itemList!!.items.size)
    }

    @Test fun detail_pane_hasFourRowsAndBothNavigateActions() {
        controller.originOverride = origin
        controller.ingestForTest(listOf(obs("A", 100.0, op = true)))
        val t = DroneDetailScreen(carContext, controller, "A", null).onGetTemplate() as PaneTemplate
        assertEquals(4, t.pane.rows.size)
        assertEquals(
            listOf("Navigate to drone", "Navigate to operator"),
            t.pane.actions.map { it.title.toString() },
        )
    }

    @Test fun detail_withoutOperator_hasOnlyDroneAction() {
        controller.ingestForTest(listOf(obs("A", 100.0)))
        val t = DroneDetailScreen(carContext, controller, "A", null).onGetTemplate() as PaneTemplate
        assertEquals(listOf("Navigate to drone"), t.pane.actions.map { it.title.toString() })
    }

    @Test fun detail_unknownDrone_isMessage() {
        val t = DroneDetailScreen(carContext, controller, "GONE", null).onGetTemplate()
        assertTrue(t is MessageTemplate)
    }
}

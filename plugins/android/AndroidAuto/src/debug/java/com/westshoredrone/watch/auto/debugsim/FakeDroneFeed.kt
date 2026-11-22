package com.westshoredrone.watch.auto.debugsim

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.westshoredrone.watch.auto.AutoController
import com.westshoredrone.watch.auto.LocalDetectionTap

/**
 * DEBUG BUILDS ONLY (src/debug source set; release has a no-op AutoDebugHooks
 * and none of these classes).
 *
 * Feeds [SimScenarios] frames into the car app through the SAME path as real
 * node-relayed frames: [LocalDetectionTap.onLocalDetection] → the session's
 * AutoController → DroneTracker (eviction, on-ground rule, alerts, quota
 * policy). Nothing here draws UI.
 *
 * Control (send after opening Westshore Watch on the DHU, so a car session exists):
 *   adb shell am broadcast -a com.westshoredrone.watch.auto.DEBUG_SIM \
 *       --es scenario one|many|churn|landing|silent|stop [--el seed 42] \
 *       -p com.westshoredrone.watch
 *
 * The scenario is centered on the phone's last location when one is known,
 * else on Brook Park, OH. It keeps its clock while the car screen is hidden and
 * resumes when it's shown again (frames are only sent while a session is started).
 */
object FakeDroneFeed {
    const val ACTION = "com.westshoredrone.watch.auto.DEBUG_SIM"
    const val EXTRA_SCENARIO = "scenario"
    const val EXTRA_SEED = "seed"
    private const val TAG = "WswAutoSim"
    private const val TICK_MS = 1_000L

    private val main = Handler(Looper.getMainLooper())
    private var receiverRegistered = false
    private var controller: AutoController? = null

    private var pendingName: String? = null
    private var pendingSeed = SimScenarios.DEFAULT_SEED
    private var scenario: SimScenario? = null
    private var startedAtMs = 0L

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val name = intent.getStringExtra(EXTRA_SCENARIO)?.trim()?.lowercase()
            val seed = intent.getLongExtra(EXTRA_SEED, SimScenarios.DEFAULT_SEED)
            main.post { select(name, seed) }
        }
    }

    /** Called by AutoDebugHooks when a car session starts (main thread). */
    fun attach(context: Context, c: AutoController) {
        controller = c
        if (!receiverRegistered) {
            // Exported so `adb shell am broadcast` (shell uid) can reach it. Debug builds only.
            ContextCompat.registerReceiver(
                context.applicationContext, receiver, IntentFilter(ACTION), ContextCompat.RECEIVER_EXPORTED,
            )
            receiverRegistered = true
            Log.i(TAG, "debug drone simulator ready: am broadcast -a $ACTION --es scenario <${SimScenarios.NAMES.joinToString("|")}|stop>")
        }
        if (scenario == null && pendingName != null) build()
        if (scenario != null) schedule()
    }

    /** Called by AutoDebugHooks when the car session stops. */
    fun detach(c: AutoController) {
        if (controller !== c) return
        controller = null
        main.removeCallbacks(tick)
    }

    private fun select(name: String?, seed: Long) {
        main.removeCallbacks(tick)
        scenario = null
        pendingName = null
        if (name == null || name == SimScenarios.STOP) {
            Log.i(TAG, "stopped (drones age out through normal eviction)")
            return
        }
        if (name !in SimScenarios.NAMES) {
            Log.w(TAG, "unknown scenario '$name'; use one of ${SimScenarios.NAMES} or stop")
            return
        }
        pendingName = name
        pendingSeed = seed
        if (controller != null) { build(); schedule() }
        else Log.i(TAG, "'$name' queued; starts when the car screen opens")
    }

    private fun build() {
        val name = pendingName ?: return
        val o = controller?.origin
        val origin = if (o != null) SimOrigin(o.lat, o.lon) else SimScenarios.BROOK_PARK
        scenario = SimScenarios.create(name, origin, pendingSeed)
        pendingName = null
        startedAtMs = System.currentTimeMillis()
        Log.i(TAG, "scenario '$name' seed=$pendingSeed at ${origin.lat},${origin.lon}" + if (o == null) " (no phone fix: Brook Park, OH)" else "")
    }

    private fun schedule() {
        main.removeCallbacks(tick)
        main.post(tick)
    }

    private val tick = object : Runnable {
        override fun run() {
            val s = scenario ?: return
            if (controller == null) return
            val elapsed = System.currentTimeMillis() - startedAtMs
            val end = s.durationMs
            if (end != null && elapsed >= end) {
                Log.i(TAG, "scenario '${s.name}' finished")
                scenario = null
                return
            }
            for (f in s.framesAt(elapsed)) {
                LocalDetectionTap.onLocalDetection(
                    f.uasId, f.lat, f.lon, f.heightM, f.speedMps, f.headingDeg,
                    f.opLat, f.opLon, f.status, specDecoded = true,
                )
            }
            main.postDelayed(this, TICK_MS)
        }
    }
}

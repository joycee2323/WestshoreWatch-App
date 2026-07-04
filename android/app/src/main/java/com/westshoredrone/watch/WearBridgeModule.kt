package com.westshoredrone.watch

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import com.google.android.gms.wearable.Wearable
import java.nio.charset.StandardCharsets

// Phone half of the Wear OS enrollment handshake. Wraps the Wearable Data Layer
// (MessageClient / NodeClient) so JS can hand the watch a one-time enrollment
// code over the encrypted BT/Data-Layer channel. The raw user JWT is NEVER sent
// — only the short-lived (90s) single-use code, which the watch redeems at
// /auth/device/enroll for its OWN device tokens. See src/services/wearEnrollment.ts.
@ReactModule(name = WearBridgeModule.NAME)
class WearBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = NAME

    // List connected Wear nodes so JS can tell whether a watch is even paired
    // (and let the user pick which one to enroll).
    @ReactMethod
    fun getConnectedWatches(promise: Promise) {
        val ctx = reactApplicationContext
        Wearable.getNodeClient(ctx).connectedNodes
            .addOnSuccessListener { nodes ->
                val arr = Arguments.createArray()
                for (n in nodes) {
                    val m = Arguments.createMap()
                    m.putString("id", n.id)
                    m.putString("displayName", n.displayName)
                    m.putBoolean("nearby", n.isNearby)
                    arr.pushMap(m)
                }
                promise.resolve(arr)
            }
            .addOnFailureListener { e ->
                Log.w(NAME, "getConnectedWatches failed: ${e.message}")
                promise.reject("NODES_FAILED", e)
            }
    }

    // Send the enrollment payload (JSON: { code, apiBase }) to a specific
    // connected watch node. The watch listens on ENROLL_PATH (its
    // WearableListenerService, task 9) and redeems the code.
    @ReactMethod
    fun sendEnrollment(nodeId: String, payloadJson: String, promise: Promise) {
        val ctx = reactApplicationContext
        val bytes = payloadJson.toByteArray(StandardCharsets.UTF_8)
        Wearable.getMessageClient(ctx).sendMessage(nodeId, ENROLL_PATH, bytes)
            .addOnSuccessListener { promise.resolve(null) }
            .addOnFailureListener { e ->
                Log.w(NAME, "sendEnrollment failed: ${e.message}")
                promise.reject("SEND_FAILED", e)
            }
    }

    companion object {
        const val NAME = "WearBridge"
        // Must match the path the watch's Data Layer listener subscribes to.
        const val ENROLL_PATH = "/westshore/enroll"
    }
}

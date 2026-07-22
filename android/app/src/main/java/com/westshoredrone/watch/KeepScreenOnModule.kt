package com.westshoredrone.watch

import android.util.Log
import android.view.WindowManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule

// Replaces expo-keep-awake on Android. expo-keep-awake's
// ExpoKeepAwakeManager resolves the Activity through the legacy Expo
// moduleRegistry's ActivityProvider, which silently fails to find the
// current Activity under Bridgeless (new arch) — the JS promise rejects
// with ERR_NO_ACTIVITY and the screen never gets FLAG_KEEP_SCREEN_ON.
// ReactContextBaseJavaModule.currentActivity works under both arches in
// this app (see BLEScannerModule.requestIgnoreBatteryOptimizationsIfNeeded),
// so we use it directly.
@ReactModule(name = KeepScreenOnModule.NAME)
class KeepScreenOnModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = NAME

    @ReactMethod
    fun activate(promise: Promise) {
        try {
            val activity = reactApplicationContext.currentActivity
            if (activity == null) {
                Log.w(NAME, "activate: currentActivity is null — flag not applied")
                promise.reject("NO_ACTIVITY", "currentActivity is null")
                return
            }
            activity.runOnUiThread {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                Log.d(NAME, "activate: FLAG_KEEP_SCREEN_ON added")
            }
            promise.resolve(null)
        } catch (t: Throwable) {
            Log.w(NAME, "activate failed: ${t.message}")
            promise.reject("ACTIVATE_FAILED", t)
        }
    }

    @ReactMethod
    fun deactivate(promise: Promise) {
        try {
            val activity = reactApplicationContext.currentActivity
            if (activity == null) {
                // Benign: nothing to clear if we never had an Activity.
                promise.resolve(null)
                return
            }
            activity.runOnUiThread {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                Log.d(NAME, "deactivate: FLAG_KEEP_SCREEN_ON cleared")
            }
            promise.resolve(null)
        } catch (t: Throwable) {
            Log.w(NAME, "deactivate failed: ${t.message}")
            promise.reject("DEACTIVATE_FAILED", t)
        }
    }

    companion object {
        const val NAME = "KeepScreenOn"
    }
}

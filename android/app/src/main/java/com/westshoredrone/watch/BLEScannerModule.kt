package com.westshoredrone.watch

import android.Manifest
import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

class BLEScannerModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "BLEScanner"

    @ReactMethod
    fun startService(promise: Promise) {
        try {
            val ctx = reactApplicationContext
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val granted = ContextCompat.checkSelfPermission(
                    ctx,
                    Manifest.permission.POST_NOTIFICATIONS
                ) == PackageManager.PERMISSION_GRANTED
                if (!granted) {
                    Log.w(
                        "BLEScannerModule",
                        "POST_NOTIFICATIONS not granted — foreground service notification will be suppressed. " +
                            "Request it from JS via PermissionsAndroid before starting."
                    )
                }
            }
            requestIgnoreBatteryOptimizationsIfNeeded()
            val intent = Intent(ctx, BLEScannerService::class.java).apply {
                action = BLEScannerService.ACTION_START
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
            // Verify the service actually came up. startForegroundService()
            // returns synchronously even when the OS later refuses to honor it
            // (e.g. permissions missing, foreground-service-type mismatch).
            // Poll ActivityManager once after a short delay so JS gets a real
            // failure instead of a silently-resolved promise.
            Handler(Looper.getMainLooper()).postDelayed({
                if (isServiceRunning(ctx)) {
                    promise.resolve(null)
                } else {
                    Log.w("BLEScannerModule", "BLEScannerService not running 1s after startForegroundService — likely permission/manifest issue")
                    promise.reject(
                        "BLE_SERVICE_NOT_RUNNING",
                        "Foreground service did not start. Check that location and Bluetooth permissions are granted."
                    )
                }
            }, SERVICE_START_VERIFY_DELAY_MS)
        } catch (e: Throwable) {
            promise.reject("BLE_SERVICE_START_FAILED", e)
        }
    }

    @Suppress("DEPRECATION")
    private fun isServiceRunning(ctx: Context): Boolean {
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
        // getRunningServices is deprecated for third-party services on API 26+
        // but still returns the caller's own services, which is all we need.
        val target = BLEScannerService::class.java.name
        return try {
            am.getRunningServices(Int.MAX_VALUE).any { it.service.className == target }
        } catch (t: Throwable) {
            Log.w("BLEScannerModule", "isServiceRunning check failed: ${t.message}")
            false
        }
    }

    @SuppressLint("BatteryLife")
    private fun requestIgnoreBatteryOptimizationsIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val ctx = reactApplicationContext
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        val pkg = ctx.packageName
        if (pm.isIgnoringBatteryOptimizations(pkg)) return
        try {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$pkg")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val activity = currentActivity
            if (activity != null) {
                activity.startActivity(intent)
            } else {
                ctx.startActivity(intent)
            }
            Log.d("BLEScannerModule", "Prompted for ignore-battery-optimizations")
        } catch (t: Throwable) {
            Log.w("BLEScannerModule", "Failed to prompt battery optimization: ${t.message}")
        }
    }

    @ReactMethod
    fun configure(config: ReadableMap, promise: Promise) {
        try {
            val baseUrl = if (config.hasKey("baseUrl")) config.getString("baseUrl") else null
            val authToken = if (config.hasKey("authToken")) config.getString("authToken") else null
            BLEScannerService.applyUploadConfig(baseUrl, authToken)
            promise.resolve(null)
        } catch (e: Throwable) {
            promise.reject("BLE_CONFIGURE_FAILED", e)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for RN NativeEventEmitter; no-op.
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for RN NativeEventEmitter; no-op.
    }

    @ReactMethod
    fun stopService(promise: Promise) {
        try {
            val ctx = reactApplicationContext
            val intent = Intent(ctx, BLEScannerService::class.java).apply {
                action = BLEScannerService.ACTION_STOP
            }
            ctx.startService(intent)
            ctx.stopService(Intent(ctx, BLEScannerService::class.java))
            promise.resolve(null)
        } catch (e: Throwable) {
            promise.reject("BLE_SERVICE_STOP_FAILED", e)
        }
    }

    companion object {
        private const val SERVICE_START_VERIFY_DELAY_MS = 1_000L
    }
}

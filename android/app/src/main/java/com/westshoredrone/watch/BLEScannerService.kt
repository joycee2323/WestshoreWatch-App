package com.westshoredrone.watch

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.ParcelUuid
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class BLEScannerService : Service() {

    private var scanner: BluetoothLeScanner? = null
    private var scanCallback: ScanCallback? = null
    private var handlerThread: HandlerThread? = null
    private var handler: Handler? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var scanning = false

    @Volatile private var uploader: DetectionUploader? = null
    @Volatile private var heartbeat: NodeHeartbeatUploader? = null

    // sourceMac (uppercased) -> most recent uasId + when BasicId last arrived.
    // Mirrors the mergeBySource TTL logic from src/services/bleScanner.ts so we
    // can attribute Location/System messages that don't carry their own uasId.
    private data class Attribution(val uasId: String, val lastBasicIdAtMs: Long)
    private val attributionBySource = java.util.concurrent.ConcurrentHashMap<String, Attribution>()

    @Volatile
    private var lastPacketElapsedMs: Long = 0L

    private val watchdogRunnable = object : Runnable {
        override fun run() {
            if (!scanning) return
            val idleMs = SystemClock.elapsedRealtime() - lastPacketElapsedMs
            if (idleMs >= WATCHDOG_SILENCE_THRESHOLD_MS) {
                Log.d(TAG, "watchdog idle ${idleMs}ms, restarting scan")
                stopScan()
                startScan()
            }
            handler?.postDelayed(this, WATCHDOG_CHECK_INTERVAL_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        if (handlerThread == null) {
            handlerThread = HandlerThread("BLEScannerService-thread").also { it.start() }
            handler = Handler(handlerThread!!.looper)
        }
        if (uploader == null) {
            val h = handler
            if (h != null) {
                uploader = DetectionUploader(h, applicationContext).also {
                    it.configure(UploadConfig.baseUrl, UploadConfig.authToken)
                    it.start()
                }
                heartbeat = NodeHeartbeatUploader(h, applicationContext).also {
                    it.configure(UploadConfig.baseUrl, UploadConfig.authToken)
                    it.start()
                }
                activeInstance = this
            }
        }
        acquireWakeLockIfNeeded()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "onStartCommand action=${intent?.action} flags=$flags startId=$startId")
        when (intent?.action) {
            ACTION_STOP -> {
                Log.d(TAG, "ACTION_STOP — stopping scan, foreground, and self")
                stopScan()
                // Best-effort flush of any buffered detections before teardown.
                uploader?.flushBlocking(3_000L)
                uploader?.stop()
                uploader = null
                heartbeat?.stop()
                heartbeat = null
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                startForegroundWithNotification()
                startScan()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        Log.d(TAG, "onDestroy")
        stopScan()
        uploader?.stop()
        uploader = null
        heartbeat?.stop()
        heartbeat = null
        if (activeInstance === this) activeInstance = null
        stopForegroundCompat()
        releaseWakeLock()
        handlerThread?.quitSafely()
        handlerThread = null
        handler = null
        super.onDestroy()
    }

    private fun acquireWakeLockIfNeeded() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).apply {
            setReferenceCounted(false)
        }
        try {
            wl.acquire()
            wakeLock = wl
            Log.d(TAG, "acquireWakeLock: PARTIAL_WAKE_LOCK acquired")
        } catch (t: Throwable) {
            Log.w(TAG, "acquireWakeLock failed: ${t.message}")
        }
    }

    private fun releaseWakeLock() {
        val wl = wakeLock ?: return
        try {
            if (wl.isHeld) wl.release()
            Log.d(TAG, "releaseWakeLock: released")
        } catch (t: Throwable) {
            Log.w(TAG, "releaseWakeLock error: ${t.message}")
        } finally {
            wakeLock = null
        }
    }

    @SuppressLint("MissingPermission")
    private fun startScan() {
        if (scanning) {
            Log.d(TAG, "startScan: already scanning, skipping")
            return
        }
        if (!hasScanPermission()) {
            Log.w(TAG, "startScan: BLUETOOTH_SCAN permission not granted; cannot scan")
            return
        }
        val btManager = getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = btManager?.adapter
        if (adapter == null || !adapter.isEnabled) {
            Log.w(TAG, "startScan: Bluetooth adapter missing or disabled")
            return
        }
        val leScanner = adapter.bluetoothLeScanner
        if (leScanner == null) {
            Log.w(TAG, "startScan: BluetoothLeScanner unavailable")
            return
        }

        val workHandler = handler ?: return

        // setLegacy(false) makes the scanner return BOTH legacy and extended
        // advertisements. Default on Android 8+ is true (legacy-only), which
        // would filter out the firmware's pack advertiser on handle 1
        // (extended PDU). We rely on the pack emission for self-identifying
        // multi-drone attribution.
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_BALANCED)
            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
            .setReportDelay(0L)
            .setLegacy(false)
            .build()

        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult?) {
                val r = result ?: return
                workHandler.post { emitScanResult(r) }
            }

            override fun onBatchScanResults(results: MutableList<ScanResult>?) {
                val list = results ?: return
                workHandler.post { list.forEach { emitScanResult(it) } }
            }

            override fun onScanFailed(errorCode: Int) {
                Log.w(TAG, "onScanFailed errorCode=$errorCode")
            }
        }

        // Two filters, OR-ed by the BLE scanner:
        //   1. ODID service data — drone detections (and Westshore Watch relays).
        //   2. Manufacturer company 0x08FE — Westshore Watch identity advertiser
        //      (handle 3 in firmware/ble_relay.c). Always on, so unclaimed nodes
        //      with no drones nearby are still discoverable for the claim flow.
        val filters = listOf(
            ScanFilter.Builder()
                .setServiceData(
                    ParcelUuid.fromString(ODID_SERVICE_UUID),
                    byteArrayOf(),
                    byteArrayOf()
                )
                .build(),
            ScanFilter.Builder()
                .setManufacturerData(
                    WESTSHORE_COMPANY_ID,
                    byteArrayOf(),
                    byteArrayOf()
                )
                .build()
        )

        workHandler.post {
            try {
                leScanner.startScan(filters, settings, cb)
                scanner = leScanner
                scanCallback = cb
                scanning = true
                lastPacketElapsedMs = SystemClock.elapsedRealtime()
                Log.d(TAG, "startScan: native BLE scan started (ODID filter, balanced) on ${Thread.currentThread().name}")
                workHandler.removeCallbacks(watchdogRunnable)
                workHandler.postDelayed(watchdogRunnable, WATCHDOG_CHECK_INTERVAL_MS)
            } catch (t: Throwable) {
                Log.e(TAG, "startScan failed: ${t.message}", t)
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun stopScan() {
        handler?.removeCallbacks(watchdogRunnable)
        val cb = scanCallback
        val s = scanner
        if (scanning && cb != null && s != null) {
            try {
                if (hasScanPermission()) {
                    s.stopScan(cb)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "stopScan error: ${t.message}")
            }
        }
        scanning = false
        scanCallback = null
        scanner = null
    }

    private fun hasScanPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) ==
                PackageManager.PERMISSION_GRANTED
        } else {
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED
        }
    }

    private fun emitScanResult(result: ScanResult) {
        val device = result.device ?: return
        val mac = device.address ?: return
        val record = result.scanRecord

        lastPacketElapsedMs = SystemClock.elapsedRealtime()

        val map: WritableMap = Arguments.createMap()
        map.putString("mac", mac)
        map.putInt("rssi", result.rssi)

        val name: String? = try {
            if (hasScanPermission()) device.name else null
        } catch (_: SecurityException) {
            null
        } ?: record?.deviceName
        if (name != null) map.putString("name", name) else map.putNull("name")

        val serviceDataMap: WritableMap = Arguments.createMap()
        record?.serviceData?.forEach { (parcelUuid, bytes) ->
            val key = parcelUuid.uuid.toString().lowercase()
            serviceDataMap.putString(key, Base64.encodeToString(bytes, Base64.NO_WRAP))
        }
        map.putMap("serviceData", serviceDataMap)

        val uuidArray: WritableArray = Arguments.createArray()
        record?.serviceUuids?.forEach { uuidArray.pushString(it.uuid.toString().lowercase()) }
        map.putArray("serviceUUIDs", uuidArray)

        val mfgData = record?.manufacturerSpecificData
        if (mfgData != null && mfgData.size() > 0) {
            val id = mfgData.keyAt(0)
            val bytes = mfgData.valueAt(0)
            val idBytes = byteArrayOf((id and 0xFF).toByte(), ((id shr 8) and 0xFF).toByte())
            val combined = idBytes + bytes
            map.putString("manufacturerData", Base64.encodeToString(combined, Base64.NO_WRAP))
        } else {
            map.putNull("manufacturerData")
        }

        val raw = record?.bytes
        if (raw != null) {
            map.putString("rawScanRecord", Base64.encodeToString(raw, Base64.NO_WRAP))
        } else {
            map.putNull("rawScanRecord")
        }

        emitEvent(EVENT_SCAN_RESULT, map)

        // Mark this node as recently-seen for the native heartbeat uploader.
        // Westshore-OUI MACs identify our own nodes; the heartbeat path is what
        // keeps nodes.last_seen current on the backend. Pre-port this lived in
        // JS (LiveMapScreen.tsx) and froze under Doze; running it here lets
        // heartbeats survive screen-off.
        val macUpper = mac.uppercase()
        if (isWestshoreWatchNode(macUpper)) {
            val deviceId = macUpper.replace(":", "").replace("-", "")
            heartbeat?.markNodeSeen(deviceId)
        }

        // Now do the Kotlin-side upload path. Screen-off Doze suspends the JS
        // runtime, so parsing + POSTing here keeps detections flowing even
        // when the JS listener is dormant.
        maybeEnqueueForUpload(macUpper, record?.serviceData)
    }

    private fun maybeEnqueueForUpload(sourceMacUpper: String, serviceData: Map<android.os.ParcelUuid, ByteArray>?) {
        val up = uploader ?: return
        if (serviceData == null) return
        val odidBytes = serviceData.entries.firstOrNull {
            it.key.uuid.toString().equals(ODID_SERVICE_UUID, ignoreCase = true)
        }?.value ?: return

        val parsed = OdidParser.parseServiceData(odidBytes) ?: return
        if (parsed.uasId == "DroneScout Bridge") return

        val now = SystemClock.elapsedRealtime()

        // Option C: Pack (msgType 0xF) advertisements are self-identifying —
        // the firmware (handle 1, extended PDU) emits basic_id + location +
        // system in one atomic AD. Bypass sourceMac-based attribution entirely
        // and trust the in-packet uasId. Do not write to attributionBySource
        // here either; legacy-path inheritance state is independent.
        val effectiveUasId: String? = if (parsed.msgType == ODID_MSG_PACK) {
            if (parsed.uasId == null) {
                Log.i(TAG, "[diag] pack with no uasId — dropped (malformed)")
                null
            } else {
                Log.i(TAG, "[diag] attrib pack sourceMac=$sourceMacUpper uasId=${parsed.uasId}")
                parsed.uasId
            }
        } else if (parsed.uasId != null) {
            // Legacy per-message path: BasicId carries a uasId and refreshes
            // the TTL; Location/System inherit the most recent one on this
            // sourceMac within the tightened TTL window.
            attributionBySource[sourceMacUpper] = Attribution(parsed.uasId, now)
            // [diag] TEMPORARY — revert after triage.
            Log.i(TAG, "[diag] attrib set sourceMac=$sourceMacUpper uasId=${parsed.uasId}")
            // TODO(notifyNewDrone): port src/services/droneNotifier.ts so
            // first-sighting notifications fire when screen-off. Hook point:
            // compare against prior attribution here and post a native
            // notification for new uasIds.
            parsed.uasId
        } else {
            // Pack-only mode: with self-identifying Pack frames (msgType 0xF) carrying
            // every drone's uasId in-band, the legacy source-MAC-based inheritance
            // fallback is no longer needed and was a known cause of two-drone position
            // swaps when BasicId arrival timing crossed between drones. If Pack
            // emission breaks at the firmware level (watch for ESP_LOGE lines from
            // ble_relay.c:286 and :292), drones will silently stop reporting until
            // Packs are restored.
            Log.i(TAG,
                "[diag] legacy frame dropped (Pack-only mode) sourceMac=$sourceMacUpper " +
                "lat=${parsed.lat} lon=${parsed.lon}")
            null
        }

        if (effectiveUasId == null) return
        if (!isWestshoreWatchNode(sourceMacUpper)) return

        val lat = parsed.lat ?: return
        val lon = parsed.lon ?: return
        if (lat == 0.0 && lon == 0.0) return

        val deviceId = sourceMacUpper.replace(":", "").replace("-", "")
        up.enqueue(
            deviceId,
            DetectionUploader.DroneRecord(
                id = effectiveUasId,
                lat = lat,
                lon = lon,
                alt = parsed.altGeo,
                spd = parsed.speedHoriz,
                hdg = parsed.heading,
                opLat = parsed.opLat,
                opLon = parsed.opLon,
            ),
        )
    }

    private fun isWestshoreWatchNode(macUpper: String): Boolean {
        return macUpper.startsWith("98:A3:16:7D") || macUpper.startsWith("38:44:BE")
    }

    private fun emitEvent(name: String, payload: WritableMap) {
        val app = application as? ReactApplication ?: return
        val reactContext: ReactContext? =
            app.reactNativeHost.reactInstanceManager.currentReactContext
        if (reactContext == null || !reactContext.hasActiveReactInstance()) return
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, payload)
        } catch (t: Throwable) {
            Log.w(TAG, "emitEvent failed: ${t.message}")
        }
    }

    private fun startForegroundWithNotification() {
        Log.d(TAG, "startForegroundWithNotification: begin")
        createChannelIfNeeded()

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentPI = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Westshore Watch scanning")
            .setContentText("Watching for nearby drones and Westshore Watch nodes")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setContentIntent(contentPI)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            Log.d(TAG, "startForegroundWithNotification: startForeground returned successfully")
        } catch (t: Throwable) {
            Log.e(TAG, "startForeground failed: ${t.javaClass.simpleName}: ${t.message}", t)
            stopSelf()
        }
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    private fun createChannelIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val existing = nm.getNotificationChannel(CHANNEL_ID)
        if (existing != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Westshore Watch BLE scanning",
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Keeps the app scanning for drones and Westshore Watch nodes in the background"
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "BLEScannerService"
        const val ACTION_START = "com.westshoredrone.watch.action.START_BLE"
        const val ACTION_STOP = "com.westshoredrone.watch.action.STOP_BLE"
        const val EVENT_SCAN_RESULT = "BLEScanResult"
        private const val ODID_SERVICE_UUID = "0000FFFA-0000-1000-8000-00805F9B34FB"
        // Westshore Watch identity advertiser company ID (handle 3 in
        // firmware/ble_relay.c, payload [MAC(6)][api_key prefix]). Used purely
        // as a discovery signature here — the app does not read the api_key
        // bytes.
        private const val WESTSHORE_COMPANY_ID = 0x08FE
        private const val CHANNEL_ID = "westshore_ble_scanner_v2"
        private const val NOTIFICATION_ID = 4471
        private const val WAKE_LOCK_TAG = "WestshoreWatch::BLEScannerService"
        // Restart only if no packets have arrived for this long (silence watchdog).
        private const val WATCHDOG_SILENCE_THRESHOLD_MS = 30_000L
        // How often the watchdog checks for silence.
        private const val WATCHDOG_CHECK_INTERVAL_MS = 5_000L
        // How long a BasicId attribution is reused for legacy-path follow-up
        // Location/System messages without their own uasId. Firmware now emits
        // basic_id every cycle (option A in ble_relay.c), so a valid inherit
        // only needs to cover the ~50ms intra-burst gap. 200ms gives ~4x
        // headroom for Android BluetoothLeScanner batching/reorder jitter
        // without letting stale attributions leak across multi-drone bursts.
        // Irrelevant for pack-parsed ads (option C) — those are self-
        // identifying and skip this path entirely.
        private const val ATTRIBUTION_TTL_MS = 200L

        // ODID Message Pack msgType — matches ODID_MSG_PACK in
        // C6-Firmware/main/odid_decoder.h and OdidParser.kt.
        private const val ODID_MSG_PACK = 0xF

        // Live reference to the running service so the native module can push
        // config updates into its uploader without restarting the service.
        @Volatile private var activeInstance: BLEScannerService? = null

        fun applyUploadConfig(baseUrl: String?, authToken: String?) {
            UploadConfig.baseUrl = baseUrl ?: UploadConfig.baseUrl
            UploadConfig.authToken = authToken
            activeInstance?.uploader?.configure(UploadConfig.baseUrl, UploadConfig.authToken)
            activeInstance?.heartbeat?.configure(UploadConfig.baseUrl, UploadConfig.authToken)
        }
    }
}

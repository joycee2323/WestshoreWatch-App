import Foundation
import CoreBluetooth
import CoreLocation
import React
import os

// iOS counterpart to:
//   android/.../BLEScannerModule.kt   (the JS-facing native module)
//   android/.../BLEScannerService.kt  (the scan loop + attribution + watchdog)
//
// Registered to JS as "BLEScanner" (see WSWBLEScanner.m RCT_EXTERN_REMAP_MODULE)
// so src/specs/NativeBLEScanner.ts's TurboModuleRegistry.get('BLEScanner')
// resolves to this class, and src/services/bleScanner.ts drives it unchanged.
//
// Exposes the SAME native method surface as the Android module — startService,
// stopService, configure, getWatchdogStats — and emits the SAME events:
//   BLEScanResult        — one per advertisement; JS parses ODID for the map
//   UploaderForcedReinit — watchdog asked JS to re-push the JWT
//   DeploymentPaused     — 402 from the detections endpoint
//   DeploymentResumed    — 2xx after a pause
//
// ───────────────────────────────────────────────────────────────────────────
// iOS PLATFORM CONSTRAINTS (do not exist on Android) — see also docs/ios-implementation.md
//
//  • NO MAC ADDRESS. CoreBluetooth never exposes a peripheral's hardware MAC,
//    only a per-app-randomized CBPeripheral.identifier (a UUID). Android keys
//    every node operation on the MAC (deviceId = MAC, OUI check). We recover the
//    node MAC from the node's own identity advertisement: the firmware's
//    company-0x08FE manufacturer-data payload is [MAC(6)][api_key prefix]
//    (firmware/ble_relay.c handle 3). We extract those 6 bytes and map
//    peripheral.identifier -> MAC. Until a peripheral has been seen advertising
//    its identity, we cannot know its deviceId, so native upload/heartbeat for
//    that peripheral is deferred (the BLEScanResult is still emitted to JS, so
//    the live map — which keys on uasId, not node MAC — works regardless).
//    NEEDS VERIFICATION: that the ODID relay advert and the identity advert
//    arrive from the SAME CBPeripheral.identifier. If the firmware uses separate
//    advertising sets with independent random addresses, the correlation breaks
//    and a different scheme (e.g. embedding the node MAC in the ODID payload) is
//    required.
//
//  • BACKGROUND SCANNING is heavily throttled by iOS and requires a service-UUID
//    filter; allowDuplicates is ignored in the background. We scan with
//    services: nil + allowDuplicates: true for reliable FOREGROUND reception
//    (needed at ODID advertising rates and to catch the 0x08FE identity advert,
//    which CoreBluetooth cannot filter on). The bluetooth-central background mode
//    keeps a limited, OS-throttled trickle alive when backgrounded, but frames
//    WILL be missed. This app is session-based; that is acceptable. There is no
//    iOS equivalent of Android's foreground service / wake lock — do not fake one.
// ───────────────────────────────────────────────────────────────────────────

@objc(WSWBLEScanner)
final class WSWBLEScanner: RCTEventEmitter, CBCentralManagerDelegate, CLLocationManagerDelegate {

    // MARK: - Constants (mirror BLEScannerService.kt companion object)
    private static let odidServiceUUID = CBUUID(string: "FFFA")
    private static let odidServiceUUIDFull = "0000fffa-0000-1000-8000-00805f9b34fb"
    private static let westshoreCompanyId: UInt16 = 0x08FE
    private static let odidMsgPack = 0xF
    private static let attributionTTLSec: TimeInterval = 0.200
    private static let bleSilenceThresholdSec: TimeInterval = 30
    private static let uploadStallThresholdSec: TimeInterval = 30
    private static let reinitBackoffSec: TimeInterval = 30
    private static let selfHealTickSec: TimeInterval = 5

    // MARK: - BLE
    private var central: CBCentralManager?
    private let bleQueue = DispatchQueue(label: "com.westshoredrone.watch.ble-central")
    private var scanning = false
    private var pendingStart = false
    private var startPromise: (resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock)?

    // peripheral.identifier.uuidString -> recovered node MAC (uppercased, colon-free).
    private var peripheralToDeviceId: [String: String] = [:]
    // sourceMac(upper) -> (uasId, lastBasicId uptime) — legacy attribution TTL.
    private var attributionBySource: [String: (uasId: String, at: TimeInterval)] = [:]
    private let stateLock = NSLock()

    // [diag] one-shot keys so the identity-recovery diagnostics fire once per
    // state transition rather than once per advert — CoreBluetooth floods
    // didDiscover under allowDuplicates. Cleared only on process restart.
    private var loggedDiag = Set<String>()

    // [diag] os_log channel — surfaces through the modern unified-log stream
    // (pymobiledevice3 / Console / Xcode) on iOS 26, unlike NSLog. Used for the
    // manufacturer-data reception probe (does the 0x08FE handle-3 EXTENDED advert
    // reach didDiscover at all?).
    private static let diagLog = OSLog(subsystem: "com.westshoredrone.watch", category: "ble")

    // MARK: - Watchdog
    private var lastPacketUptime: TimeInterval = 0
    private var bleReinitCount = 0
    private var lastBleReinitUptime: TimeInterval = 0
    private var lastUploaderReinitUptime: TimeInterval = 0
    private var selfHealTimer: DispatchSourceTimer?

    // MARK: - Uploaders + location
    private let uploader = WSWDetectionUploader()
    private let heartbeat = WSWNodeHeartbeatUploader()
    private var locationManager: CLLocationManager?

    // MARK: - Config (survives service restarts, like UploadConfig.kt)
    private var baseUrl: String? = "https://api.westshoredrone.com"
    private var authToken: String?

    private var hasListeners = false

    // MARK: - RCTEventEmitter plumbing

    override init() {
        super.init()
        uploader.emit = { [weak self] name, body in self?.sendIfListening(name, body) }
    }

    override static func requiresMainQueueSetup() -> Bool { true }

    override func supportedEvents() -> [String]! {
        return ["BLEScanResult", "UploaderForcedReinit", "DeploymentPaused", "DeploymentResumed"]
    }

    override func startObserving() { hasListeners = true }
    override func stopObserving() { hasListeners = false }

    private func sendIfListening(_ name: String, _ body: [String: Any]) {
        guard hasListeners else { return }
        sendEvent(withName: name, body: body)
    }

    // MARK: - JS-facing methods (signatures bridged in WSWBLEScanner.m)

    @objc(startService:rejecter:)
    func startService(_ resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        bleQueue.async { [weak self] in
            guard let self = self else { return }
            if self.scanning {
                resolve(nil); return
            }
            self.pendingStart = true
            self.startPromise = (resolve, reject)
            if self.central == nil {
                // CBCentralManager init triggers the system Bluetooth permission
                // prompt (NSBluetoothAlwaysUsageDescription). The actual scan is
                // kicked off in centralManagerDidUpdateState once .poweredOn.
                self.central = CBCentralManager(delegate: self, queue: self.bleQueue,
                                                options: [CBCentralManagerOptionShowPowerAlertKey: true])
            } else if self.central?.state == .poweredOn {
                self.beginScan()
            }
            self.setupLocationIfNeeded()
            self.uploader.configure(baseUrl: self.baseUrl, authToken: self.authToken)
            self.heartbeat.configure(baseUrl: self.baseUrl, authToken: self.authToken)
            self.uploader.start()
            self.heartbeat.start()
        }
    }

    @objc(stopService:rejecter:)
    func stopService(_ resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        bleQueue.async { [weak self] in
            guard let self = self else { return }
            self.selfHealTimer?.cancel(); self.selfHealTimer = nil
            if self.scanning { self.central?.stopScan() }
            self.scanning = false
            self.pendingStart = false
            self.uploader.stop()
            self.heartbeat.stop()
            resolve(nil)
        }
    }

    @objc(configure:resolver:rejecter:)
    func configure(_ config: NSDictionary,
                   resolver resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
        if let b = config["baseUrl"] as? String, !b.isEmpty { baseUrl = b }
        // authToken may legitimately be cleared (null) on logout.
        authToken = config["authToken"] as? String
        uploader.configure(baseUrl: baseUrl, authToken: authToken)
        heartbeat.configure(baseUrl: baseUrl, authToken: authToken)
        resolve(nil)
    }

    @objc(getWatchdogStats:rejecter:)
    func getWatchdogStats(_ resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
        let now = ProcessInfo.processInfo.systemUptime
        var map: [String: Any] = [:]
        stateLock.lock()
        let scanningNow = scanning
        let lastPkt = lastPacketUptime
        let bleReinit = bleReinitCount
        stateLock.unlock()

        map["bleReinitCount"] = bleReinit
        map["uploaderReinitCount"] = uploader.reinitCount()
        map["scanning"] = scanningNow
        if scanningNow && lastPkt > 0 {
            map["lastBleCallbackAgeMs"] = Int((now - lastPkt) * 1000)
        } else {
            map["lastBleCallbackAgeMs"] = NSNull()
        }
        let ls = uploader.lastSuccessUptimeValue()
        if ls > 0 {
            map["lastUploadSuccessAgeMs"] = Int((now - ls) * 1000)
        } else {
            map["lastUploadSuccessAgeMs"] = NSNull()
        }
        resolve(map)
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if pendingStart { beginScan() }
        case .unauthorized, .poweredOff, .unsupported:
            if let p = startPromise {
                p.reject("BLE_SERVICE_NOT_RUNNING",
                         "Bluetooth is unavailable (state=\(central.state.rawValue)). Grant Bluetooth permission and enable Bluetooth.",
                         nil)
                startPromise = nil
                pendingStart = false
            }
        default:
            break
        }
    }

    private func beginScan() {
        guard central?.state == .poweredOn else { return }
        // services: nil so we also receive the 0x08FE identity advert (which has
        // no FFFA service UUID); allowDuplicates so we see every ODID frame.
        // Both are foreground-only behaviors — see the constraints note up top.
        central?.scanForPeripherals(withServices: nil,
                                    options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        scanning = true
        pendingStart = false
        lastPacketUptime = ProcessInfo.processInfo.systemUptime
        startSelfHeal()
        if let p = startPromise { p.resolve(nil); startPromise = nil }
        os_log("[WSWBLEScanner] scan started (services=nil, allowDuplicates=true)",
               log: WSWBLEScanner.diagLog, type: .info)
        // [diag] os_log canary — if this surfaces in the capture but the per-advert
        // mfg lines below never show 0x08FE, reception (not logging) is the gap.
        os_log("[WSWBLEScanner] scan started (os_log canary)",
               log: WSWBLEScanner.diagLog, type: .info)
    }

    func centralManager(_ central: CBCentralManager,
                        didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any],
                        rssi RSSI: NSNumber) {
        let nowUptime = ProcessInfo.processInfo.systemUptime
        stateLock.lock(); lastPacketUptime = nowUptime; stateLock.unlock()

        let pid = peripheral.identifier.uuidString

        // Recover the node MAC from the 0x08FE identity advert, if present.
        // deviceId stays colon-free (uppercase, no separators) — it's the
        // backend node id used verbatim in the /api/nodes/<deviceId>/... URLs.
        var nodeDeviceId: String? = nil
        if let mfg = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data, mfg.count >= 2 {
            let companyId = UInt16(mfg[0]) | (UInt16(mfg[1]) << 8) // little-endian
            // [diag] PER-ADVERT manufacturer-data probe (os_log, not deduped): one
            // line per advert with company id + length, so we can tell definitively
            // whether the X1's 0x08FE handle-3 EXTENDED advert ever reaches
            // didDiscover. When it's ours, also dump the full hex to verify the
            // on-air [companyLE(2)][MAC(6)][api_key] layout. Reception probe only —
            // NOT the identity-parse fix.
            os_log("[WSWBLEScanner] mfg company=0x%{public}04X len=%{public}d",
                   log: WSWBLEScanner.diagLog, type: .info, Int(companyId), mfg.count)
            if companyId == WSWBLEScanner.westshoreCompanyId {
                let hex = mfg.map { String(format: "%02X", $0) }.joined(separator: " ")
                os_log("[WSWBLEScanner] mfg 0x08FE raw=%{public}@ len=%{public}d",
                       log: WSWBLEScanner.diagLog, type: .info, hex, mfg.count)
            }
            if companyId == WSWBLEScanner.westshoreCompanyId, mfg.count >= 8 {
                let macBytes = mfg.subdata(in: 2..<8)
                let mac = macBytes.map { String(format: "%02X", $0) }.joined()
                stateLock.lock(); peripheralToDeviceId[pid] = mac; stateLock.unlock()
                nodeDeviceId = mac
                logOnce("id:\(pid):\(mac)", "identity recovered pid=\(pid) -> mac=\(mac)")
            }
        }
        if nodeDeviceId == nil {
            stateLock.lock(); nodeDeviceId = peripheralToDeviceId[pid]; stateLock.unlock()
        }

        // ── Emit BLEScanResult to JS (payload mirrors BLEScannerService.emitScanResult) ──
        // The JS contract (and Android) keys on a COLON-separated MAC: the
        // shared bleScanner.ts isWestshoreWatchNode() does startsWith('38:44:BE'),
        // so we must hand JS the colon form (Android sends device.address).
        // Fall back to the peripheral UUID until the identity advert is seen.
        let emitMac = nodeDeviceId.map(colonMac) ?? peripheral.identifier.uuidString
        emitScanResult(peripheral: peripheral, advertisementData: advertisementData,
                       rssi: RSSI, emitMac: emitMac)

        // ── Native heartbeat + upload paths (mirror maybeEnqueueForUpload) ──
        if let deviceId = nodeDeviceId, isWestshoreWatchNode(deviceId) {
            logOnce("seen:\(deviceId)", "markNodeSeen deviceId=\(deviceId)")
            heartbeat.markNodeSeen(deviceId)
        }
        maybeEnqueueForUpload(deviceId: nodeDeviceId, pid: pid,
                              advertisementData: advertisementData, nowUptime: nowUptime)
    }

    private func emitScanResult(peripheral: CBPeripheral,
                                advertisementData: [String: Any],
                                rssi: NSNumber,
                                emitMac: String) {
        var map: [String: Any] = [:]
        // emitMac is already in the JS-expected shape: a colon-separated MAC
        // ("38:44:BE:A5:79:46") once the identity advert has been seen, else the
        // peripheral UUID. JS's isWestshoreWatchNode() does a colon-ful prefix
        // match, so node-claim/proximity only light up once the MAC is known.
        map["mac"] = emitMac
        map["rssi"] = rssi.intValue
        if let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name {
            map["name"] = name
        } else {
            map["name"] = NSNull()
        }

        var serviceDataMap: [String: String] = [:]
        if let sd = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data] {
            for (uuid, data) in sd {
                // Match Android's lowercase full-128-bit UUID keys so the JS
                // lookup for the FFFA service data is identical across platforms.
                serviceDataMap[fullLowercaseUUID(uuid)] = data.base64EncodedString()
            }
        }
        map["serviceData"] = serviceDataMap

        var uuidArray: [String] = []
        if let uuids = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] {
            uuidArray = uuids.map { fullLowercaseUUID($0) }
        }
        map["serviceUUIDs"] = uuidArray

        if let mfg = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data {
            // Android prepends [companyId LE][bytes]; CoreBluetooth's
            // manufacturer data already includes the company id prefix, so this
            // is byte-compatible with the Android "manufacturerData" field.
            map["manufacturerData"] = mfg.base64EncodedString()
        } else {
            map["manufacturerData"] = NSNull()
        }

        // iOS does not expose the full raw advertisement payload (no Android
        // ScanRecord.getBytes() equivalent). JS treats null gracefully.
        map["rawScanRecord"] = NSNull()

        sendIfListening("BLEScanResult", map)
    }

    private func maybeEnqueueForUpload(deviceId: String?,
                                       pid: String,
                                       advertisementData: [String: Any],
                                       nowUptime: TimeInterval) {
        guard let sd = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data] else { return }
        // Find the FFFA ODID service data.
        var odid: Data?
        for (uuid, data) in sd where fullLowercaseUUID(uuid) == WSWBLEScanner.odidServiceUUIDFull {
            odid = data
        }
        guard let odidData = odid else { return }
        let parsed = WSWOdidParser.parseServiceData([UInt8](odidData))
        guard let parsed = parsed else { return }
        if parsed.uasId == "DroneScout Bridge" { return }

        // [diag] Pack frame attribution. attrib=MISS means the ODID advert's
        // CBPeripheral has no recovered MAC — the native heartbeat/upload then
        // can't fire (this is the offline-node failure). Compare the pid here
        // with the "identity recovered" pid: same pid expected if the firmware
        // advertises both sets from one BLE address.
        if parsed.msgType == WSWBLEScanner.odidMsgPack {
            logOnce("pack:\(pid):\(deviceId ?? "MISS")",
                    "pack frame pid=\(pid) attrib=\(deviceId ?? "MISS") uasId=\(parsed.uasId ?? "nil")")
        }

        // Without a recovered node MAC we cannot form the deviceId for the POST
        // URL. Emit-to-JS already happened; just skip the native upload.
        guard let deviceId = deviceId else { return }
        if !isWestshoreWatchNode(deviceId) { return }

        // Attribution: Pack frames are self-identifying (Option C). Legacy
        // per-message frames inherit the most recent BasicId on this source
        // within the TTL. Mirrors BLEScannerService.maybeEnqueueForUpload.
        let effectiveUasId: String?
        if parsed.msgType == WSWBLEScanner.odidMsgPack {
            effectiveUasId = parsed.uasId
        } else if let uasId = parsed.uasId {
            stateLock.lock(); attributionBySource[deviceId] = (uasId, nowUptime); stateLock.unlock()
            effectiveUasId = uasId
        } else {
            // Pack-only mode: legacy inheritance fallback intentionally dropped
            // (matches the Kotlin Pack-only decision that fixed two-drone swaps).
            effectiveUasId = nil
        }
        guard let uasId = effectiveUasId else { return }
        guard let lat = parsed.lat, let lon = parsed.lon, !(lat == 0 && lon == 0) else { return }

        uploader.enqueue(deviceId: deviceId, record: WSWDetectionUploader.DroneRecord(
            id: uasId, lat: lat, lon: lon, alt: parsed.altGeo, spd: parsed.speedHoriz,
            hdg: parsed.heading, opLat: parsed.opLat, opLon: parsed.opLon,
            odidTimestamp: parsed.odidTimestamp
        ))
    }

    // Mirrors BLEScannerService.isWestshoreWatchNode — OUI check on the recovered
    // colon-free uppercase MAC ("98A3167D…" / "3844BE…").
    private func isWestshoreWatchNode(_ deviceIdUpper: String) -> Bool {
        return deviceIdUpper.hasPrefix("98A3167D") || deviceIdUpper.hasPrefix("3844BE")
    }

    // Colon-format a colon-free uppercase MAC ("3844BEA57946") into the
    // Android device.address shape ("38:44:BE:A5:79:46") the shared JS expects.
    // Returns the input unchanged if it isn't a 12-char hex MAC.
    private func colonMac(_ macUpperNoSep: String) -> String {
        let chars = Array(macUpperNoSep)
        guard chars.count == 12 else { return macUpperNoSep }
        var out = ""
        for i in stride(from: 0, to: 12, by: 2) {
            if !out.isEmpty { out += ":" }
            out.append(chars[i]); out.append(chars[i + 1])
        }
        return out
    }

    // [diag] Emit an os_log the first time a given key is seen, so runtime
    // diagnostics mark state transitions instead of spamming per advert.
    private func logOnce(_ key: String, _ message: String) {
        stateLock.lock()
        let isNew = loggedDiag.insert(key).inserted
        stateLock.unlock()
        if isNew {
            os_log("[WSWBLEScanner] %{public}@", log: WSWBLEScanner.diagLog, type: .info, message)
        }
    }

    private func fullLowercaseUUID(_ uuid: CBUUID) -> String {
        // CBUUID for a 16-bit UUID stringifies as "FFFA"; expand to the full
        // 128-bit Bluetooth base UUID form Android uses.
        let s = uuid.uuidString.lowercased()
        if s.count == 4 {
            return "0000\(s)-0000-1000-8000-00805f9b34fb"
        }
        return s
    }

    // MARK: - Self-heal (mirrors BLEScannerService.selfHealRunnable, BLE leg)

    private func startSelfHeal() {
        selfHealTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: bleQueue)
        t.schedule(deadline: .now() + WSWBLEScanner.selfHealTickSec,
                   repeating: WSWBLEScanner.selfHealTickSec)
        t.setEventHandler { [weak self] in self?.selfHealTick() }
        selfHealTimer = t
        t.resume()
    }

    private func selfHealTick() {
        let now = ProcessInfo.processInfo.systemUptime
        stateLock.lock()
        let isScanning = scanning
        let bleIdle = now - lastPacketUptime
        let sinceReinit = now - lastBleReinitUptime
        stateLock.unlock()

        if isScanning && bleIdle >= WSWBLEScanner.bleSilenceThresholdSec
            && sinceReinit >= WSWBLEScanner.reinitBackoffSec {
            os_log("[WSWBLEScanner] no adverts in %{public}ds — restarting scan",
                   log: WSWBLEScanner.diagLog, type: .info, Int(bleIdle))
            stateLock.lock(); bleReinitCount += 1; lastBleReinitUptime = now; stateLock.unlock()
            central?.stopScan()
            beginScan()
        }

        if !uploader.isIdle() {
            let stale = now - uploader.lastSuccessUptimeValue()
            if stale >= WSWBLEScanner.uploadStallThresholdSec
                && (now - lastUploaderReinitUptime) >= WSWBLEScanner.reinitBackoffSec {
                lastUploaderReinitUptime = now
                uploader.reinitForStall("no successful upload in \(Int(stale))s, queued=\(uploader.queueSize())")
            }
        }
    }

    // MARK: - Location (foreground; feeds heartbeat last_lat/last_lon)

    private func setupLocationIfNeeded() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if self.locationManager == nil {
                let lm = CLLocationManager()
                lm.delegate = self
                lm.desiredAccuracy = kCLLocationAccuracyHundredMeters
                lm.requestWhenInUseAuthorization()
                self.locationManager = lm
            }
            self.locationManager?.startUpdatingLocation()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        heartbeat.updateLocation(locations.last)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        os_log("[WSWBLEScanner] location error: %{public}@",
               log: WSWBLEScanner.diagLog, type: .error, error.localizedDescription)
    }
}

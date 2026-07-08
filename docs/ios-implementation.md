# iOS Implementation — Full Operational Parity

This document describes the **current** iOS architecture, which supersedes the
viewer-only plan in [ios-screen-inventory.md](./ios-screen-inventory.md). iOS
now functions exactly like Android: full node pairing, BLE detection relay,
cloud upload, and heartbeat reporting, against the same backend endpoints and
user flows.

The iOS app is **session-based**: it works in the foreground; backgrounded
behavior is best-effort within iOS constraints (no expectation of multi-hour
shift operation, and no Android-style foreground service).

---

## Component map

| Concern | Android (committed Kotlin, `android/`) | iOS (committed Swift, `plugins/ios/BLEScanner/`) |
|---|---|---|
| JS-facing native module | `BLEScannerModule.kt` | `WSWBLEScanner.swift` + `WSWBLEScanner.m` |
| Scan loop / attribution / watchdog | `BLEScannerService.kt` | `WSWBLEScanner.swift` |
| ODID byte parser | `OdidParser.kt` | `WSWOdidParser.swift` |
| Detection uploader | `DetectionUploader.kt` | `WSWDetectionUploader.swift` |
| Heartbeat uploader | `NodeHeartbeatUploader.kt` | `WSWNodeHeartbeatUploader.swift` |
| Module registration | `BLEScannerPackage.kt` + `MainApplication.kt` | `withBleScanner.js` config plugin |

The shared JS layer is unchanged across platforms:
`src/specs/NativeBLEScanner.ts` (`TurboModuleRegistry.get('BLEScanner')`) and
`src/services/bleScanner.ts` drive both native modules identically. The
cross-platform `src/services/odidParser.ts` is still used by the JS map path.

---

## Native module contract (identical on both platforms)

The JS module name is **`BLEScanner`**. On iOS this is achieved with
`RCT_EXTERN_REMAP_MODULE(BLEScanner, WSWBLEScanner, RCTEventEmitter)`.

**Methods** (promise-based, called from `bleScanner.ts`):

- `startService()` — begins BLE scanning + starts the detection/heartbeat uploaders
- `stopService()` — stops scanning + uploaders
- `configure({ baseUrl, authToken })` — pushes the upload endpoint + JWT
- `getWatchdogStats()` — `{ bleReinitCount, uploaderReinitCount, lastBleCallbackAgeMs, lastUploadSuccessAgeMs, scanning }`
- `addListener` / `removeListeners` — provided by `RCTEventEmitter`

**Events** (emitted to JS via `RCTEventEmitter` → `NativeEventEmitter` /
`DeviceEventEmitter`):

- `BLEScanResult` — one per advertisement; payload `{ mac, rssi, name, serviceData, serviceUUIDs, manufacturerData, rawScanRecord }`, mirroring `BLEScannerService.emitScanResult`. JS parses the FFFA `serviceData` for the live map.
- `UploaderForcedReinit` — watchdog asked JS to re-push the JWT
- `DeploymentPaused` — `402` from the detections endpoint (billing pause)
- `DeploymentResumed` — `2xx` after a pause

---

## Detection upload path

1. `CBCentralManager` discovers an advertisement → `didDiscover`.
2. `WSWBLEScanner` emits `BLEScanResult` to JS (live map) **and** runs the
   native upload path (so detections flow even when the JS thread is busy).
3. `WSWOdidParser` decodes the FFFA service data. Pack frames (`msgType 0xF`)
   are self-identifying; legacy frames inherit the most recent BasicId on the
   source within a 200 ms TTL — identical to `BLEScannerService`.
4. Westshore-OUI nodes enqueue a `DroneRecord` into `WSWDetectionUploader`.
5. The uploader flushes every **500 ms**, coalescing by `(deviceId, uasId)`,
   to `POST /api/nodes/<deviceId>/detections` with body
   `{ drones: [{ id, lat, lon, alt, spd, hdg, op_lat, op_lon, ts }] }`,
   `Authorization: Bearer <jwt>`.
6. Status handling matches Android: `402` → re-enqueue + `DeploymentPaused` +
   exponential backoff (5 s → 60 s cap); `401` → clear token; `404` → drop node
   for the session; `2xx` after a pause → `DeploymentResumed`.

## Heartbeat path

`WSWNodeHeartbeatUploader` POSTs `/api/nodes/<deviceId>/heartbeat` with
`{ connection_type: "ble_relay", last_lat, last_lon }` every **30 s** for nodes
seen in the last **60 s**, forgetting nodes idle > **5 min**. The phone's
location comes from a foreground `CLLocationManager`
(`NSLocationWhenInUseUsageDescription`), pushed into the heartbeat uploader by
`WSWBLEScanner`.

## Self-heal watchdog

`WSWBLEScanner` runs a 5 s tick mirroring `BLEScannerService.selfHealRunnable`:
restart the scan if no adverts arrive for 30 s (bumping `bleReinitCount`), and
force an uploader reinit if the queue is non-empty but no `2xx` lands in 30 s
(emitting `UploaderForcedReinit`), each gated by a 30 s backoff.

---

## iOS-specific constraints (do not exist on Android)

1. **No MAC address.** CoreBluetooth exposes only a per-app-randomized
   `CBPeripheral.identifier`, never the hardware MAC. Android keys every node
   operation on the MAC. We recover the node MAC from the node's own identity
   advertisement (company `0x08FE`, payload `[MAC(6)][api_key prefix]` per
   `firmware/ble_relay.c`) and map `peripheral.identifier → MAC`. Until a
   peripheral has been seen advertising its identity, its `deviceId` is unknown,
   so native upload/heartbeat for it is deferred — but the `BLEScanResult` is
   still emitted, so the live map (keyed on `uasId`) works regardless.
   **Verify on hardware** that the ODID relay advert and the `0x08FE` identity
   advert arrive from the same `CBPeripheral.identifier`; if the firmware uses
   independent advertising sets with separate random addresses, the correlation
   breaks and the node MAC must instead be embedded in the ODID payload.

2. **Background scanning is throttled.** iOS requires a service-UUID filter for
   background scans and ignores `allowDuplicates` in the background. We scan
   `services: nil, allowDuplicates: true` for reliable **foreground** reception
   (needed at ODID rates, and to catch the un-filterable `0x08FE` identity
   advert). The `bluetooth-central` background mode keeps a limited, OS-throttled
   trickle alive when backgrounded; frames **will** be missed. Acceptable for a
   session-based app.

3. **No foreground service / wake lock.** There is no iOS equivalent of
   Android's `BLEScannerService` foreground service, `PARTIAL_WAKE_LOCK`, or
   battery-optimization exemption. We do not fake one.

4. **No raw advertisement bytes.** CoreBluetooth has no
   `ScanRecord.getBytes()` equivalent, so `rawScanRecord` is always `null` in
   the emitted `BLEScanResult`. JS handles null gracefully.

5. **Permissions.** `NSBluetoothAlwaysUsageDescription` (BLE central) and
   `NSLocationWhenInUseUsageDescription` (heartbeat location) in
   `app.config.js`; `UIBackgroundModes: ['remote-notification', 'bluetooth-central']`.

---

## Build / registration

Because `expo prebuild` regenerates `ios/`, the Swift/Obj-C sources live in the
repo-tracked `plugins/ios/BLEScanner/` and are injected at prebuild by the
`plugins/withBleScanner.js` config plugin (registered in `app.config.js`),
which copies the files into the generated Xcode project, adds them to the app
target, and wires the Swift bridging header. After `eas build --platform ios`,
`TurboModuleRegistry.get('BLEScanner')` should resolve to `WSWBLEScanner`.

See the "things to verify on first iOS build" checklist in the implementation PR
/ commit message — the native pieces cannot be compiled without macOS/EAS.

---

## Backend

No backend changes. iOS uses the same `/api/nodes/:device_id/detections` and
`/heartbeat` endpoints and the same `push_tokens` table (APNs via Expo Push).
iOS detection uploads contribute to the same `node_id` records and are
race-merged by `detectionCoalescer.js` the same way multiple Android nodes are.

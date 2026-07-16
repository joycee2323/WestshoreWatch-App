# iOS build 9 → build 10: BLE / detection diff

*Scope: everything touching BLE scanning, identity-advert parsing, and node-relay
detection between the tree submitted as iOS build 9 and the tree submitted as
build 10. Written for someone who knows the architecture and wants to verify each
claim.*

App repo: `C:\dev\WestshoreWatch`.

---

## TL;DR / verdict

1. **The iOS native BLE code did not change at all.** `WSWBLEScanner.swift`,
   `WSWNodeHeartbeatUploader.swift`, `WSWDetectionUploader.swift`,
   `WSWOdidParser.swift`, `WSWBLEScanner.m`, and the bridging header are
   **byte-identical** between the two builds. The `0x08FE` company-ID check, the
   `mfg.count >= 8` gate, the `peripheralToDeviceId` cache, the scan config
   (`scanForPeripherals(withServices: nil, allowDuplicates)`), and the
   CBCentralManager options are unchanged. **Nothing to look at in the parser.**
2. **No permission / Info.plist / background-mode change.** `app.config.js`'s iOS
   Bluetooth usage string and `UIBackgroundModes` are untouched; the only plist-ish
   change is a notification *icon*. There is no new permission gate.
3. **Scan start is unchanged.** The `LiveMapScreen` `startBleScanning` effect and
   `requestPermissions` are byte-identical, and the `permissionResolved` spinner
   gate **already existed in build 9** — it is not new. There is **no
   fresh-install-specific scanning regression** in this diff.
4. **One real, functional regression — but not the one hypothesized.** The build-10
   merge silently dropped the iOS-only `useRelayTarget(...)` call from
   `LiveMapScreen`. Nothing now calls `setRelayDeployment`, so `relayDeploymentId`
   stays `null` forever and **the iOS node-less detection upload never fires**.
   This disables backend reporting of any detection that isn't attributed to a
   recovered node MAC. **It affects every build-10 iOS launch, not just fresh
   installs** (the flag is in-memory, reset to `null` on every launch).

If the field symptom is "in-range node recognition broken on a fresh install
only," this diff does **not** explain it — scanning and recognition are unchanged.
The concrete regression this diff *does* contain is the relay-target upload clobber
(§4), which is universal on build 10.

---

## Build boundaries

| Build | Commit | Date | Notes |
|---|---|---|---|
| 9 | `91f82046` | 2026-07-02 | commit that set `ios.buildNumber:'9'`; = merge `389df7e3`'s first parent (`389df7e3^1` is `buildNumber '9'`) |
| 10 | `389df7e3` → HEAD `5ff2ec3d` | 2026-07-06 → 07-08 | merge "…version align" set `buildNumber:'10'`; still `'10'` at HEAD |

`389df7e3` is a merge: `^1` = the iOS branch (build 9, `buildNumber '9'`), `^2` =
`origin/master` (`buildNumber '1'` — the Android release train). Diffs below are
`git diff 91f82046 HEAD` (build-9 tree → build-10 tree); the merge structure is
irrelevant to a two-point tree diff.

## Files changed in the BLE surface (`git diff --stat 91f82046 HEAD`)

```
 app.config.js              | 16 ++++++------
 src/services/bleScanner.ts | 44 +++++++++++++++++-----------
```

Everything else in the BLE file list — **all six native iOS files**,
`WSWOdidParser.swift`, `detectionUpload.ts`, `odidParser.ts`, `NativeBLEScanner.ts`,
`withBleScanner.js` — is **unchanged**. (`LiveMapScreen.tsx` also changed, but not
in its scan/permission logic — see §3/§4.)

---

## 1. Native iOS BLE code — zero changes

`git diff --stat 91f82046 HEAD -- plugins/ios/BLEScanner/…` returns **empty**. The
identity-advert parser you were concerned about (`WSWBLEScanner.swift:263-286`,
company `0x08FE`, `mfg.count >= 8`, `subdata(in: 2..<8)`, `peripheralToDeviceId`
caching) and the scan lifecycle (`beginScan()` at `:231-249`,
`scanForPeripherals(withServices: nil, options:[…AllowDuplicatesKey: true])`) are
exactly as in build 9. No change to scan start/stop, permission request flow, or
CoreBluetooth scan options on the native side.

## 2. `app.config.js` — version bumps + notification icon only

Full diff (`git diff 91f82046 HEAD -- app.config.js`) is three hunks:

- `version: '1.1.0' → '1.1.4'`
- `ios.buildNumber: '9' → '10'`
- `android.versionCode: 18 → 25`
- `expo-notifications`: added `icon: './assets/notification-icon.png'` (+ reworded
  comment).

**Not changed** (still present verbatim, `app.config.js:23-34`):

```js
infoPlist: {
  NSBluetoothAlwaysUsageDescription:
    'Westshore Watch uses Bluetooth to receive Remote ID broadcasts relayed from your Westshore Watch detection nodes.',
  …
  UIBackgroundModes: ['remote-notification', 'bluetooth-central'],
```

There is no `ios/` directory in the repo (it's `.easignored` and regenerated on
each cloud build), so the Info.plist is authored entirely here — and the Bluetooth
usage string, `bluetooth-central` background mode, and the `expo-location` plugin
permission block are all untouched. **No permission surface changed.**

## 3. Scan start / permission gate — unchanged (and `permissionResolved` is not new)

`LiveMapScreen.tsx` changed by 393/135 lines, but the churn is node-marker
rendering and map-camera logic. Filtering the diff to only added/removed lines that
mention permission/scan/BLE yields just an import edit and comment rewording — **no
logic**:

```
-import { startBleScanning, stopBleScanning, getBridgeInRange } from '../services/bleScanner';
+import { startBleScanning, stopBleScanning } from '../services/bleScanner';
-  // (protocol-signature proximity, NOT node identity — see bleScanner). bleScanner
+  // See `permissionResolved` declaration for the race-condition rationale.
+  // Show a spinner until the OS permission prompt has been answered;
```

Verified byte-identical between builds:

- The `startBleScanning` effect (`requestPermissions().then(() => { setPermissionResolved(true); loadActiveDeployment(); startBleScanning(...) })` + `BLE_SERVICE_NOT_RUNNING` alert + cleanup) — build 9 lines 393-472 vs build 10 lines 419-500: **identical**.
- `requestPermissions` (the `PermissionsAndroid.requestMultiple([BLUETOOTH_SCAN, BLUETOOTH_CONNECT])` Android-only block) — unchanged; iOS takes no branch here (BLE permission is prompted by CBCentralManager init natively).
- `permissionResolved` — declared in **both** builds (`build9:232`, `build10:243`) with the same rationale comment; the `if (!permissionResolved)` spinner gate exists in both (`build9:953`, `build10:1205`).

So: **no new permission step, no new state check gating scan start, no
fresh-install-vs-upgrade difference in when scanning begins.** Both fresh and
upgraded installs hit the identical `requestPermissions().then(startBleScanning)`
path.

*(Cosmetic side effect: the "NODE IN RANGE" badge display — the `bridgeInRange`
`useState`/`useEffect`/`getBridgeInRange` — was removed from `LiveMapScreen` in the
same merge. The underlying machinery still runs in `bleScanner.ts` (`getBridgeInRange`
`:288`, `startBridgeProximityTimer` `:303,:510`, `BridgeInRangeChanged` emits); only
the on-screen badge was dropped. Display-only, not detection.)*

## 4. `bleScanner.ts` — additive OUI fallback (cannot break recognition)

The only change is renaming `isNodeIdentityAdvert(manufacturerData)` →
`isWestshoreWatchNode(mac, manufacturerData)` and **adding** the legacy MAC-OUI
fallback (the `6b369a66` logic merged in from master):

```ts
-function isNodeIdentityAdvert(manufacturerData: string | null): boolean {
-  if (!manufacturerData) return false;
-  …return companyId === WESTSHORE_COMPANY_ID;
+function isWestshoreWatchNode(mac: string, manufacturerData: string | null): boolean {
+  if (manufacturerData) { … if (…=== WESTSHORE_COMPANY_ID) return true; }
+  const upper = mac.toUpperCase();
+  return upper.startsWith('98:A3:16:7D') || upper.startsWith('38:44:BE');
 }
```
Call site (`bleScanner.ts:344`): `if (isWestshoreWatchNode(mac, device.manufacturerData))`.

This is **purely additive** — it returns `true` in every case build 9 did (the
`0x08FE` branch is preserved) plus the OUI cases. It can only recognize *more*
nodes, never fewer. On iOS the OUI branch is largely moot (pre-recovery `mac` is the
peripheral UUID, not a MAC), so behavior is effectively unchanged. It drives the
`discoveredNodes` map / in-range signal, **not** the native MAC-recovery or upload
path. **This cannot break in-range detection.**

---

## 5. THE REGRESSION — iOS node-less upload silently disabled

### What broke

`useRelayTarget` is the **only** thing that sets the relay deployment. Its `apply`
callback (`src/hooks/useRelayTarget.ts:55-58`) is the sole non-null caller of
`setRelayDeployment`:

```ts
const apply = useCallback((id: string | null) => {
  chosenRef.current = id;
  setRelayDeployment(id);   // → bleScanner.ts relayDeploymentId
}, []);
```

`relayDeploymentId` is the gate on the entire iOS node-less upload
(`bleScanner.ts:484-501`):

```ts
if ( relayDeploymentId && typeof parsed.lat === 'number' && … ) {
  enqueueDetectionUpload(relayDeploymentId, { id: effectiveUasId, lat, lon, … });
}
```

- **Build 9** called the hook: `LiveMapScreen.tsx:172` → `useRelayTarget(activeDeployments, orgId)`.
- **Build 10** does not. `grep -rn 'useRelayTarget|setRelayDeployment' src/` finds
  **no caller** anywhere — only the hook definition and comments. `relayDeploymentId`
  therefore stays `null` for the whole session, and `enqueueDetectionUpload` is
  **never reached**.

### Root cause — merge clobber, not an intentional removal

The `useRelayTarget(...)` call vanished in the build-10 merge `389df7e3`:

- `389df7e3^1` (build 9 / iOS branch): `useRelayTarget(` occurs **1×**.
- `389df7e3^2` (origin/master, `buildNumber '1'`): occurs **0×** — master's
  `LiveMapScreen` never had the iOS-only line.
- The merge resolved that region to master's side, dropping the call. There is **no
  replacement** (relay-target wiring is now dead code), so this is an accidental
  loss of an iOS-only change during a master→iOS-branch merge, not a deliberate
  redesign. The commit subject ("notification-focus + wear + version align") gives
  no indication relay upload was meant to be disabled.

### Practical impact (precise)

Still works on build 10:
- Local live map (the `onDetection` → `updateBleDrone` path is independent of
  `relayDeploymentId`).
- Node recognition / the scanner-level in-range signal.
- **Native** node-attributed upload — `WSWDetectionUploader` →
  `/api/nodes/<mac>/detections` — fires from Swift `maybeEnqueueForUpload`,
  independent of `relayDeploymentId`. Node heartbeats likewise.

Broken on build 10:
- **iOS node-less backend reporting** — any detection *without* a recovered
  Westshore node MAC (DroneScout/BlueMark bridge, DJI, or a node whose `0x08FE`
  identity advert hasn't been captured) is no longer POSTed to
  `/api/deployments/<id>/detections`. Per `docs/ios-detection-attribution.md` §4,
  that node-less path is effectively the primary iOS reporting path, so this is a
  meaningful loss of backend visibility on iOS.

### Fresh install vs upgrade

**No difference.** `relayDeploymentId` is in-memory module state in `bleScanner.ts`,
initialized to `null` and only ever set by the (now-absent) hook. Every app launch —
fresh or in-place upgrade — starts with it `null` and nothing sets it. So this
regression is **universal across all build-10 iOS installs**; it is not gated on
first-run permissions or cached state. (This corrects the fresh-install hypothesis:
the diff contains no cached-state-dependent behavior on the BLE path.)

### Minimal fix

Restore the single call in `LiveMapScreen` (alongside the other ref-sync effects,
where build 9 had it at line 172):

```ts
import { useRelayTarget } from '../hooks/useRelayTarget';
…
useRelayTarget(activeDeployments, orgId);
```

The hook, `setRelayDeployment`, and the upload path are all still intact — only the
call site was lost. Verify by confirming `relayDeploymentId` becomes non-null after
the map picks an operable deployment, then that `enqueueDetectionUpload` fires.

---

## Reference — where to verify

| Claim | Location |
|---|---|
| Native iOS BLE files unchanged | `git diff --stat 91f82046 HEAD -- plugins/ios/BLEScanner/` → empty |
| No plist / bg-mode / permission change | `git diff 91f82046 HEAD -- app.config.js`; unchanged `app.config.js:23-34` |
| Scan start + `requestPermissions` identical | build9 `LiveMapScreen` 393-472 / 506-… vs build10 419-500 / 532-… |
| `permissionResolved` pre-existed | `build9:232,953` and `build10:243,1205` |
| bleScanner change is additive OUI fallback | `git diff 91f82046 HEAD -- src/services/bleScanner.ts`; `bleScanner.ts:242-259,344` |
| `useRelayTarget` is sole relay-target setter | `src/hooks/useRelayTarget.ts:55-58`; gate `bleScanner.ts:484` |
| Call present build 9, absent build 10 | `389df7e3^1` (1×) vs `389df7e3^2` (0×); `grep -rn useRelayTarget src/` |

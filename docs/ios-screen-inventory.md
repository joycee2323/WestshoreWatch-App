# iOS Screen Inventory & Adaptation Plan

Phase 0, step 1 of the Westshore Watch iOS port. This document captures the
audit of every screen in the existing React Native Android app and the
decisions made about how each one ships on iOS.

The iOS app is **viewer-only**. Portable nodes (M1, X1, X1 Cellular) require
an Android companion device to relay Remote ID broadcasts; Sentinel runs
standalone. iOS users see everything their organization's nodes detect, but
cannot pair portable nodes from an iPhone or iPad.

---

## Status legend

- **Ships** — works on iOS as-is or with the abstraction layer stubs
- **Ships with adaptation** — works but needs UI changes (platform-branched
  copy, hidden Android-only elements, etc.)
- **Disabled with explainer** — visible in iOS UI but non-functional, with a
  clear message about why and what to do instead
- **Hidden** — not present in iOS UI at all

---

## Audit table

| # | Screen | iOS Status | Notes |
|---|---|---|---|
| 1 | LoginScreen | Ships | Pure form + API |
| 2 | RegisterScreen | Ships | Pure form + API; ToS / Privacy checkboxes already cross-platform |
| 3 | ForgotPasswordScreen | Ships | Pure form + API |
| 4 | GuestScanScreen | Hidden | Pre-auth BLE scanning demo; impossible on iOS |
| 5 | OnboardingScreen | Ships with adaptation | iOS variant of the body content explains architecture and removes the BLE-pairing CTA |
| 6 | LiveMapScreen | Ships with adaptation | iOS skips `startBleScanning`, hides the proximity badge, skips Android-only permission flows |
| 7 | DeploymentsScreen | Ships | Backend-driven |
| 8 | NodesScreen | Ships with adaptation | Hide "+ ADD" and "SCAN FOR NEARBY NODE →" CTAs on iOS; iOS empty-state copy variant |
| 9 | AddNodeScreen | Disabled with explainer | iOS replaces the screen body with an architecture explainer; route stays registered |
| 10 | NotificationsScreen | Ships | Backend-driven list |
| 11 | NotificationPreferencesScreen | Ships | Toggles map cleanly; iOS `Switch` styling already handled |
| 12 | SettingsScreen | Ships with adaptation | Replace "BLE SCANNING: Active" row on iOS; gate Watchdog diagnostic to Android dev builds |
| 13 | BillingScreen | Ships (verify) | Confirm no native Stripe SDK calls before submission |
| 14 | ChangePasswordScreen | Ships | Pure form + API |
| 15 | AdminWebScreen | Ships | `WebView` wrapper |
| 16 | KeepScreenOnToggle (component) | Needs iOS twin | Swift TurboModule using `UIApplication.shared.isIdleTimerDisabled` |

**Tally:** 8 ship unchanged · 5 ship with adaptation · 1 disabled with explainer · 1 hidden · 1 native module to write

---

## Per-screen adaptation details

### 4. GuestScanScreen — Hidden

The pre-auth "try it without an account" demo uses `startBleScanning`
directly to scan for nearby nodes and drones. iOS cannot do this; the
feature is hidden entirely from the iOS app.

**Action:** in `src/navigation/AppNavigator.tsx`, gate the
`<Stack.Screen name="GuestScan" component={GuestScanScreen} />` registration
on `Platform.OS !== 'ios'`. The route never appears in the iOS stack, so any
attempt to navigate to it is a no-op.

**Entry points to audit:** any pre-auth screen (Login, Register,
ForgotPassword) that links to GuestScan needs that link platform-gated too.
None currently link to it directly based on the audit, but verify before
shipping.

### 5. OnboardingScreen — Ships with adaptation

The current onboarding body assumes the user is about to pair a portable
node via BLE. On iOS this is misleading at best, and the primary "SCAN FOR
NEARBY NODE" CTA routes to a screen that doesn't work.

**Approach:** keep the existing screen shell (header, sign-out button,
ScrollView with RefreshControl, skip link) and platform-branch only the
`<View style={s.body}>` block. Less code drift than a full
`OnboardingScreen.ios.tsx` fork.

**iOS body content draft:**

> **NO NODES REGISTERED**
>
> Westshore Watch portable nodes (M1, X1) pair with an Android companion
> device that relays Remote ID broadcasts to the cloud. Sentinel stationary
> nodes pair through their own setup process and run independently.
>
> Once any node in your organization is paired and online, this app shows
> you everything it sees — live detections, flight paths, deployments,
> statistics, and alerts.
>
> [GET WESTSHORE WATCH SENTINEL — $1,999]   ← Sentinel first on iOS
> [GET WESTSHORE WATCH X1 — $799]
> [GET WESTSHORE WATCH M1 — $399]
>
> SKIP FOR NOW — I'll add a node from another device

**Key changes vs. Android version:**

- No "SCAN FOR NEARBY NODE" primary CTA.
- Sentinel promoted to the top of the hardware list (the iOS-friendly product).
- "I don't have a node yet" phrasing rewritten to "I'll add a node from another device" so users who do own portable hardware understand what to do next.
- Product link destinations (`westshoredrone.com/watch-x1/` etc.) are unchanged. Eventually the product pages themselves should call out the Android requirement for M1/X1; that's outside this doc.

### 6. LiveMapScreen — Ships with adaptation

LiveMap is the most entangled screen but the changes are narrow.

**iOS skips:**

- The `startBleScanning(...)` call in the mount `useEffect` and its error handling — iOS has no BLE relay role.
- The Android-specific blocks inside `requestPermissions()` (`PermissionsAndroid.requestMultiple` for `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT`, and `POST_NOTIFICATIONS` on Android 13+). Location-foreground request stays.
- The `nearbyNodes` count badge ("📡 NODE IN RANGE") never appears, since `updateNearbyNode` is only called from the BLE scanner callback.

**iOS keeps unchanged:**

- WebSocket subscription (active and passive modes).
- Backend detection rendering, flight paths, drone selection sheet, nickname editing.
- `DeviceEventEmitter` listeners for `DeploymentPaused` / `DeploymentResumed` — nothing emits these events on iOS, so the listeners stay mounted but never fire. Harmless.
- Initial camera centering, passive polling, all reconnection / focus / foreground refresh logic.
- KeepScreenOnToggle (with iOS native module — see component entry).

**Implementation note:** route the BLE skip through the platform abstraction
layer (`src/platform/bleScanner.ts`) rather than scattering
`Platform.OS === 'android'` checks inline. The abstraction layer stub on iOS
returns immediately from `startBleScanning` and `stopBleScanning`, and
`isBleScanning()` always returns `false`.

### 8. NodesScreen — Ships with adaptation

Pure backend data; the screen lists nodes and supports rename, reorder,
assign, and unassign — all of which work fine on iOS for nodes that an
Android device (or Sentinel) has already paired.

**iOS hides:**

- The "+ ADD" button in the header row.
- The "SCAN FOR NEARBY NODE →" CTA in the empty state.
- `handleAddNode` becomes unreachable; can stay defined or be platform-gated.

**iOS-specific empty-state copy:**

> **NO NODES**
>
> Pair nodes from the Westshore Watch Android app — they'll appear here
> automatically. Sentinel nodes pair through their own setup process.

**Recommended capability gate:** introduce
`c.canPairNodeOnThisDevice = c.canPairNode && Platform.OS === 'android'`
in `src/lib/caps.ts`. Use that for the CTAs instead of scattering platform
checks. Role-based gating (operator/admin) remains via `c.canPairNode`.

### 9. AddNodeScreen — Disabled with explainer

The screen stays registered in the navigator so existing navigation calls
(from NodesScreen on Android, OnboardingScreen on Android, push notification
deep links, etc.) don't crash if they ever reach it on iOS. The body is
replaced entirely on iOS.

**iOS body content draft:**

> **PAIRING UNAVAILABLE ON iOS**
>
> Westshore Watch portable nodes (M1, X1, X1 Cellular) pair with an Android
> companion device that handles Remote ID detection relay. Sentinel
> stationary nodes pair through their own setup process.
>
> Once a node is paired on your Android device, it appears here
> automatically — including on this iPhone.
>
> [Learn more about how Westshore Watch works →]

**Implementation:** branch at the top of the component on `Platform.OS === 'ios'`
and return the explainer view before any of the BLE scanning logic runs. No
permission requests, no scanner start, no polling.

### 12. SettingsScreen — Ships with adaptation

Three small changes:

1. **"BLE SCANNING: Active" row** in the App Info card is wrong on iOS.
   Replace with `MODE: Viewer (iPhone)` or hide the row entirely on iOS.

2. **Watchdog diagnostic** (`__DEV__` only) calls `getWatchdogStats()` from
   the BLE service. Gate the SettingRow on
   `__DEV__ && Platform.OS === 'android'`. The Push diagnostic row stays on
   both platforms — it's a JS-level helper with no native dependency.

3. **`getWatchdogStats()`** should be a no-op stub on iOS that returns
   `null`. The existing UI already handles the null case gracefully
   ("BLE service not running yet — start scanning first").

### 13. BillingScreen — Verify before shipping

Reached via `setShowBilling(true)` from SettingsScreen. Likely
WebView/redirect-based since the dashboard handles the Stripe Checkout
flow. **Before iOS submission, confirm** there are no native Stripe SDK
calls in this screen — if any are found, route through Checkout instead.
Also relevant for App Store review: Stripe-based subscriptions are
defensible for a physical-hardware-plus-service product, but reviewers may
ask about IAP. Have the response ready.

### 16. KeepScreenOnToggle — Needs iOS native module

Used by LiveMapScreen and GuestScanScreen (GuestScan is hidden on iOS, so
effectively LiveMap is the only iOS consumer).

**iOS implementation** (Swift TurboModule, draft only — compile and verify
once a Mac or EAS iOS build is available):

```swift
@objc(KeepScreenOn)
class KeepScreenOn: NSObject {
  @objc func activate() {
    DispatchQueue.main.async {
      UIApplication.shared.isIdleTimerDisabled = true
    }
  }
  @objc func deactivate() {
    DispatchQueue.main.async {
      UIApplication.shared.isIdleTimerDisabled = false
    }
  }
}
```

Plus the TurboModule spec and Objective-C bridging. The JS-side
`KeepScreenOnToggle` component does not need iOS-specific code — it calls
into the native module via the existing abstraction, and the iOS module
fulfills the same contract as the Android `KeepScreenOnModule.kt`.

---

## Platform abstraction layer surface

The following native modules and APIs need a `src/platform/*` shim so the
rest of the codebase stops branching on `Platform.OS`:

| Concern | Android | iOS stub behavior |
|---|---|---|
| BLE scanner | `startBleScanning`, `stopBleScanning`, `isBleScanning` from `src/services/bleScanner.ts` | All resolve immediately / return `false` |
| Watchdog stats | `getWatchdogStats` from same module | Returns `null` |
| Screen wake lock | `KeepScreenOnModule.kt` | `UIApplication.shared.isIdleTimerDisabled` (Swift TurboModule) |
| Deployment lifecycle events | `DeviceEventEmitter` for `DeploymentPaused` / `DeploymentResumed`, emitted from `NodeHeartbeatUploader.kt` / `DetectionUploader.kt` | Never emitted; listeners stay mounted, harmless |
| Android permission requests | `PermissionsAndroid.requestMultiple` for `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT` / `POST_NOTIFICATIONS` | iOS branch skips these entirely; iOS handles notification permission through Expo Notifications |
| Push delivery | FCM via `@react-native-firebase/messaging` (Android path) | APNs via Expo Notifications; backend push sender branches on `platform` column |

The new capability flag
`c.canPairNodeOnThisDevice = c.canPairNode && Platform.OS === 'android'`
lives in `src/lib/caps.ts` and is used by NodesScreen, OnboardingScreen,
LiveMapScreen (the "ADD YOUR FIRST NODE" banner), and AddNodeScreen.

---

## Verification still needed

1. **BillingScreen** — confirm no native Stripe SDK calls (see screen #13).
2. **DeploymentsScreen** — assumed pure backend; spot-check before shipping.
3. **AdminWebScreen** — assumed WebView wrapper; spot-check that the WebView
   config doesn't use any Android-only props.
4. **OnboardingScreen iOS body** — review the proposed copy with stakeholders
   before implementation.

---

## Out of scope for this document

- The grep audit for `Platform.OS === 'android'` and other platform-specific
  code across the wider codebase (services, stores, components, native
  module bridges). That's Phase 0 step 2.
- The platform abstraction layer implementation (Phase 0 step 3).
- iPad-specific layout work (deferred to v1.1+).
- App Store listing, screenshots, review notes (Phase 0 step 10).
- APNs backend wiring (Phase 0 step 7).

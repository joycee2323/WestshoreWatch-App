# Android Auto: status (updated 2026-11-22, release build 1.3.0 (44))

Branch `feature/android-auto`, based on `origin/master` be505b82. Pushed and opened as a PR
(unmerged) on 2026-11-22 at the user's request, together with an EAS production Android build.
No iOS build, no OTA, no merge. No production API was written to by the car work.

## Update 2026-11-22: release build 1.3.0 (44)

* **DHU testing (debug build, reported by you):** scenarios `one`, `many`, `landing`, `silent`
  and `stop` all passed, and a **16-minute `churn` soak** passed with no errors (no quota/"app
  ran into an error" message).
* **Version:** Android `versionName` 1.2.5 → **1.3.0**, `versionCode` 43 → **44**, in
  `android/app/build.gradle` only (EAS reads these for this bare project). `app.config.js`
  (`expo.version`, `android.versionCode`, `android.runtimeVersion`) and `strings.xml` stay at
  1.2.5/43 on purpose: any `app.config.js` edit changes the iOS fingerprint (measured), which
  would stop OTAs reaching shipped iOS builds. The Android OTA runtime stays **1.2.5**. That's safe
  because the car code adds no native module that JS calls. iOS fingerprint before and after:
  `3ea5e99fc169b458f4c70559607b1adb06b7ac0b`.
* **EAS production build** (AAB, store distribution, commit abce8b82):
  https://expo.dev/accounts/westshoredrone/projects/westshorewatch/builds/7fee119c-640a-4834-ace8-4a0b2c94e9d2.
  Signed with the existing remote upload keystore. The simulator is absent from its dex.
* **Still open:** the DHU tested the **debug** build, which accepts any host. Whether the
  **release** build appears and opens in real Android Auto (the allowlist question below) is
  only provable by installing it from Play internal testing.

> ### ⚠ Open question: release host allowlist (read this)
> Release builds bind only to hosts that hold `TEMPLATE_RENDERER` or whose signing certificate
> is in the Car App Library's `hosts_allowlist_sample` (3 Android Auto + 3 AAOS digests). This is
> **the officially documented approach** (the `CarAppService.createHostValidator` reference doc
> points to that list, and its release example is exactly our code). Key rotation is handled:
> the validator checks the host's whole certificate history. What I **could not prove** here is
> that today's Android Auto app is signed by one of those certificates, because that needs the
> real app on a device. The first install from Play **internal testing** (release build) must
> show up in the Android Auto launcher and open. If it doesn't appear or won't open, logcat
> shows the host validator rejecting the host. Then upgrade `androidx.car.app` before
> anything else. Details: decisions log, 2026-11-22 task 3.

## What changed tonight

1. **Rebased** onto `origin/master` (one JS-only merge, no overlapping files, no conflicts) and
   re-verified everything.
2. **Debug-only fake drone simulator**: adb broadcast scenarios `one / many / churn / landing /
   silent / stop`, fed through the real `LocalDetectionTap` → `AutoController` → `DroneTracker`
   path. Debug source set only; release has an empty `AutoDebugHooks` stub. Receiver is
   registered at runtime (no manifest entry anywhere). 8 seeded JVM tests.
3. **Release host validator** kept on the library's documented allowlist, extracted into
   `CarHostValidators`, with 5 Robolectric tests (pinned digests, debug = allow-all, release
   rejects unknown and impersonating hosts).
4. **DHU installed** on this PC: Command-line Tools 23.0 + Desktop Head Unit 2.0, from Google's
   SDK repository (checksum-verified). Exact commands in `android-auto.md`.
5. **Play review kit** (`play-review-notes.md`) and **PR text** (`android-auto-PR-description.md`).
6. **Location**: ignores last-known fixes older than 5 min at session start, requests one fresh
   fix, and logs when no fix arrives in 15 s. No new permissions. Findings documented.

## Verified (from a clean build, after all changes)

| Check | Result |
|---|---|
| `./gradlew clean`, then `:app:testDebugUnitTest assembleDebug assembleRelease :app:lintVitalRelease :app:processReleaseManifest` (JBR 21, `-Xmx6g -XX:MaxMetaspaceSize=1536m`) | **BUILD SUCCESSFUL** (9m11s), no warnings from the car code |
| JVM tests | **89/89**: 72 from session 1 + 8 simulator + 5 host validator + 4 location freshness |
| `node --test test/*.test.mjs` | **387/387** |
| `npx tsc --noEmit` | clean |
| iOS fingerprint (`npx fingerprint fingerprint:generate --platform ios`) | **`3ea5e99fc169b458f4c70559607b1adb06b7ac0b`**, unchanged |
| Merged release manifest vs `origin/master`'s (diffed) | Adds exactly: `MAP_TEMPLATES`, the `androidx.car.app.connection` `<queries>` provider entry, `com.google.android.gms.car.application` + `minCarApiLevel=5` meta-data, `WswCarAppService` (exported, POI), and the library's disabled `CarAppMetadataHolderService`, non-exported `CarAppPermissionActivity` and `CarAppNotificationBroadcastReceiver`. **No new dangerous permission, no debug receiver.** |
| Release APK has no simulator | Pre-R8 release classes: no `debugsim` (0 files; debug has 31). R8 `mapping.txt`: no `debugsim`/`FakeDroneFeed`/`SimScenario`. Release dex: 0 hits for `com.westshoredrone.watch.auto.DEBUG_SIM`, `WswAutoSim`, `SIM-ONE-1`, `debugsim` (the debug dex has all of them, so the check works). Only the empty `AutoDebugHooks` stub remains (`I8.j`). |

## Still NOT verified

* **Nothing has run on the DHU or in a car.** The DHU is installed, but it needs your phone.
* Real Android Auto accepted by the **release** host validator (see the box above).
* Template quota on a real host: the 15-min `churn` soak.
* Native JWT read from expo-secure-store on a real device ("phone app killed" launch).
* Location in a car session with the phone app closed and not scanning.
* Navigation intents opening Google Maps/Waze from the car.
* Phone-app regression run (the only change to existing phone code is still the one
  `BLEScannerService` line that returns immediately without a car session).
* WebSocket/REST against production (deliberately not called from here).

## Morning steps

```powershell
cd C:\dev\WestshoreWatch-auto
git log --oneline origin/master..feature/android-auto     # 10 commits
```

Read: this file → `android-auto-decisions.md` (session 2 at the bottom) → `android-auto.md`.

**1. DHU session (~45 min).** Full setup in `android-auto.md` → "Running on the Desktop Head
Unit". Short version:

```powershell
# phone: Android Auto developer mode → ⋮ → Start head unit server; USB debugging on; plug in
adb install -r C:\dev\WestshoreWatch-auto\android\app\build\outputs\apk\debug\app-debug.apk
# (debug APK needs Metro for the phone UI: `npx expo start` in the worktree + `adb reverse tcp:8081 tcp:8081`)
# open the phone app, sign in, allow location
adb forward tcp:5277 tcp:5277
& "$env:LOCALAPPDATA\Android\Sdk\extras\google\auto\desktop-head-unit.exe"
# in the DHU: open Westshore Watch, THEN send scenarios:
adb logcat -s WswAutoSim WswAutoFeed WswAutoLocation CarApp.H CarApp
```

Fake drones (send after the car app is open on the DHU):

```
adb shell am broadcast -a com.westshoredrone.watch.auto.DEBUG_SIM --es scenario one     -p com.westshoredrone.watch
adb shell am broadcast -a com.westshoredrone.watch.auto.DEBUG_SIM --es scenario many    -p com.westshoredrone.watch
adb shell am broadcast -a com.westshoredrone.watch.auto.DEBUG_SIM --es scenario churn   -p com.westshoredrone.watch
adb shell am broadcast -a com.westshoredrone.watch.auto.DEBUG_SIM --es scenario landing -p com.westshoredrone.watch
adb shell am broadcast -a com.westshoredrone.watch.auto.DEBUG_SIM --es scenario silent  -p com.westshoredrone.watch
adb shell am broadcast -a com.westshoredrone.watch.auto.DEBUG_SIM --es scenario stop    -p com.westshoredrone.watch
```

| Scenario | Expect |
|---|---|
| `one` | 1 drone ~300 m away circling, 197 ft high, 28.1 mph, plus an OP row. Runs until `stop`. |
| `many` | 8 drones; list capped at the host limit, nearest first, operators dropped first. |
| `churn` | 15 min of drones coming and going: **no "app ran into an error"** (quota soak). |
| `landing` | Drone descends, touches down at ~40 s, gone ~5 s later and stays gone. |
| `silent` | Drone stops at 30 s, dropped ~15 s later. |

Work through the checklist in `android-auto.md` (each item names its scenario). Also check
location with the phone app swiped away and not scanning: if `WswAutoLocation` logs "no location
fix 15 s after start", the car-only session doesn't get location (fails safe, documented).

**2. Record the review video and screenshots** following `play-review-notes.md` (c). Screenshots
go in `docs/android-auto-screens/`.

**3. If all good:** open the PR with `docs/android-auto-PR-description.md` (fill in the DHU
line). Then a separate version bump, an EAS production build, and **Play internal testing**. Install
from Play and confirm it shows in Android Auto (the open question above). Then *Form factors →
Android Auto* with the review notes and App access text from `play-review-notes.md`.

**Cleanup when done:** `git worktree remove C:\dev\WestshoreWatch-auto` (its
`android/app/google-services.json` is a gitignored copy). The DHU and cmdline-tools stay in the SDK.

## Risks (most important first)

1. **Template quota on real hosts** (unchanged; the `churn` soak tests it).
2. **Release host allowlist** (box above). Documented approach, unproven on a device.
3. **Play review / category fit** (PC-1) and empty state (PF-1). The review kit addresses both.
4. **Location with the phone app closed and not scanning** may be withheld. Fails safe.
5. **expo-secure-store coupling** for the native JWT read. Fails safe to "Sign in on your phone".

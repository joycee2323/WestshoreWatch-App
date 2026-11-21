# Android Auto: status (written last, 2026-11-21 ~07:45 EST)

Branch `feature/android-auto`, 3 commits on top of `origin/master` (3e36b74c).
Worktree: `C:\dev\WestshoreWatch-auto`. Nothing was pushed, merged, deployed or built
on EAS. The shared checkout `C:\dev\WestshoreWatch` was not touched (still on local
`master`).

## What works (built + tested)

* **Android Auto POI car app** (Car App Library 1.7.0, `minCarApiLevel 5`):
  * Main screen: host-drawn map + list of live drones, nearest first, with distance
    (`DistanceSpan`), direction, AGL altitude, speed and "seen N s ago". Red drone pins,
    blue "OP" operator rows/pins, "NEW" highlight for 30 s, empty state with feed status.
  * Detail pane: position, altitude/speed/heading, operator, Remote ID, plus
    **Navigate to drone** / **Navigate to operator** (`geo:` via `CarContext.startCarApp`).
  * Sign-in gate ("Sign in on your phone"), and a location-permission prompt action.
  * Live updates throttled to one per 3 s, designed to stay inside the 5-template quota
    (stable row titles, sticky order, app-driven refresh on Car API 6+ hosts, else frozen
    rows + refresh button).
  * Batched new-drone `CarToast` (≤ 1 per 10 s, silent).
  * Eviction: 15 s silence, 5 s grounded (firmware defaults). Legacy-decoded
    speed/heading hidden.
* **Works without the JS runtime:** native WebSocket + REST hydrate (read-only) and the
  JWT read natively from expo-secure-store. Plus a local BLE tap that's a no-op when no
  car session is running.
* **Prebuild-safe:** code in `plugins/android/AndroidAuto/`, wired by the idempotent
  `plugins/withAndroidAuto.js`. The committed `android/` has the byte-identical gradle
  block + manifest entries (a test enforces this).
* **iOS untouched:** iOS fingerprint is unchanged (`3ea5e99f…` before and after; the guard in
  `fingerprint.config.js` is what keeps it so, since without it the hash changes to `61715478…`).

## What was verified, and how

| Check | Result |
|---|---|
| `./gradlew clean` then `:app:testDebugUnitTest assembleDebug assembleRelease :app:lintVitalRelease :app:processReleaseManifest` | **BUILD SUCCESSFUL** (7m16s), no warnings from the car code |
| JVM unit tests | **72/72 pass**: 56 pure-logic (geo/format, tracker eviction, sorting/sticky order, row-limit trimming, quota policy, throttle, alert batching, parsers, secure-store format, on-ground rule) + **8 Robolectric template tests** that build the real templates through the library's validation + 8 existing `OdidParserTest` |
| JS tests `node --test test/*.test.mjs` | **371/371 pass** (6 new: plugin idempotency, committed-android parity, fingerprint strip) |
| `npx tsc --noEmit` | clean |
| Merged release manifest | contains `WswCarAppService` (exported, POI intent filter), `MAP_TEMPLATES`, `com.google.android.gms.car.application → @xml/automotive_app_desc`, `minCarApiLevel=5`. The library adds only `CarAppPermissionActivity`, `CarAppNotificationBroadcastReceiver` (both non-exported), a disabled metadata service and a `<queries>` provider entry. **No new dangerous permissions.** versionCode 43 / min 31 / target 36 unchanged |
| R8 (release) | `com.westshoredrone.watch.auto.WswCarAppService` keeps its name. The library ships consumer keep rules |
| iOS fingerprint | `3ea5e99fc169b458f4c70559607b1adb06b7ac0b`, identical to `origin/master` |

## What was NOT verified

* **Not run on the Desktop Head Unit or in a car.** No DHU, emulator image or device is
  available on this machine (details in the decisions log). No screenshots exist;
  `docs/android-auto-screens/` was not created.
* Real host behavior for template refreshes and quota (the docs are followed exactly, but
  only a real host can confirm it).
* Native JWT read from expo-secure-store on a real device (format verified against the
  15.0.8 source; decryption itself untested).
* WebSocket/REST against production: deliberately not called from here.
* Phone location while only the car screen is visible (foreground-permission semantics).
* Navigation intents launching Google Maps/Waze from the car.
* No regression run on a phone. The only change to existing code is one call in
  `BLEScannerService` that returns immediately when no car session is running.

## Risks (most important first)

1. **Template quota on real hosts.** If a host counts updates more strictly than documented,
   a long session with drones coming and going could hit "app ran into an error". Mitigated
   (see `ListRefreshPolicy`), but needs the 10-minute soak test on the DHU.
2. **Play review / category fit.** POI is the right category technically, but a reviewer may
   question live drones as "points of interest" (PC-1) and will likely see only the empty
   state (PF-1). The review-notes guidance is in `docs/android-auto.md`.
3. **expo-secure-store coupling.** An expo-secure-store upgrade could change the storage
   format. That fails safe (falls back to `UploadConfig`; worst case "sign in on phone"
   until the phone app is opened once).
4. **Background location** may be unavailable when the phone app is closed. That fails
   safe (last fix, or no distances).
5. **Merge conflicts:** the branch is based on `origin/master`, which is 39 commits ahead
   of your local `master`.

## Next steps for you (morning)

```bash
cd C:\dev\WestshoreWatch
git fetch                                   # optional; nothing was pushed
git log origin/master..feature/android-auto --stat   # the 3 commits of this work
# (`git log master..feature/android-auto --stat` also works, but your local master is
#  39 commits behind origin/master, so it would list those upstream commits too.)
git diff origin/master...feature/android-auto -- android app.config.js fingerprint.config.js
```

Read in this order: `docs/android-auto-STATUS.md` (this file),
`docs/android-auto-decisions.md`, `docs/android-auto.md`.

1. **Try it on the DHU** (≈30 min): install the DHU via Android Studio SDK Manager, phone in
   Android Auto developer mode, then from `C:\dev\WestshoreWatch-auto`:
   `npx expo run:android` (or `adb install android/app/build/outputs/apk/debug/app-debug.apk`),
   sign in on the phone, then `adb forward tcp:5277 tcp:5277` and run `desktop-head-unit.exe`.
   Work through the checklist in `docs/android-auto.md`. Most important: the "phone app
   killed" launch and the 10-minute soak with drones coming and going (simulators:
   `wsw-skydio-sim-tx`).
2. Take the DHU screenshots (list, detail, empty) into `docs/android-auto-screens/`.
3. If it all checks out: open a PR from `feature/android-auto` (I didn't), bump
   `versionCode`/`version` for a native release, build with EAS, upload to **Internal
   testing**, then **Advanced settings → Form factors → Add form factor → Android Auto**,
   following the Play Console checklist in `docs/android-auto.md`.
4. Merging this does **not** affect OTA for iOS (fingerprint unchanged). Android needs a
   new native build to get the feature, like any native change.
5. Cleanup when done: `git worktree remove C:\dev\WestshoreWatch-auto`. Its
   `android/app/google-services.json` is a gitignored copy of yours.

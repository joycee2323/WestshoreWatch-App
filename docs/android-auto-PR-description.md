# PR text for `feature/android-auto`

Paste when you open the PR (base `master`). Not opened by me. The test-evidence numbers are
from the final clean verification on 2026-11-22 (branch head before this doc commit);
re-run them if you change anything.

---

**Title:**

```
Android Auto: POI car app showing live drones (Car App Library 1.7.0)
```

**Body:**

```markdown
## Summary

Adds an Android Auto experience to the Android phone app: a **point-of-interest** car app that
shows live Remote ID drones (and their operators) on a host-drawn map, nearest first, with a
detail pane and **Navigate to drone / operator**. Android only; iOS is untouched (iOS runtime
fingerprint unchanged, so OTA updates keep reaching shipped iOS builds).

Design, decisions and test plan: `docs/android-auto.md`, `docs/android-auto-decisions.md`,
`docs/android-auto-STATUS.md`. Play submission text: `docs/play-review-notes.md`.

## What changed

- **Car code** (Kotlin, package `com.westshoredrone.watch.auto`) in
  `plugins/android/AndroidAuto/` so `expo prebuild --clean` can't wipe it:
  `WswCarAppService` (POI), list screen (`PlaceListMapTemplate`), detail screen
  (`PaneTemplate`), a native read-only feed (WebSocket `SUBSCRIBE_ORG` + REST hydrate, JWT read
  natively from expo-secure-store so it works with the phone app closed), drone tracker
  (15 s silence / 5 s grounded eviction), template-quota policy, 3 s update throttle, batched
  new-drone toasts.
- **Config plugin** `plugins/withAndroidAuto.js` (manifest entries + a generated gradle block);
  the committed `android/` carries identical edits (a JS test enforces parity).
- **`BLEScannerService.kt`**: one call that offers each relayed frame to the car list. It
  returns immediately when no car session is running.
- **`fingerprint.config.js`**: keeps the Android-only plugin out of the iOS fingerprint.
- **Release host validation**: the library's documented `hosts_allowlist_sample`
  (Android Auto + AAOS host certificates), extracted into `CarHostValidators` with tests.
- **Debug-only fake-drone simulator** (`src/debug`; release gets a no-op stub): adb broadcast
  scenarios `one / many / churn / landing / silent / stop` for DHU testing without drones.
- Docs, decisions log, Play review kit.

Release manifest additions: `WswCarAppService` (exported, POI intent filter),
`androidx.car.app.MAP_TEMPLATES`, the `com.google.android.gms.car.application` and
`minCarApiLevel=5` meta-data, plus the library's own non-exported components. **No new
dangerous permissions, no `ACCESS_BACKGROUND_LOCATION`, no version bump** in this PR.

## Risks

1. **Template quota on real hosts** (the main one). Mitigated by stable row titles, sticky
   order, app-driven refresh on Car API 6+, and frozen rows plus a refresh button on older
   hosts. Needs the 15-minute `churn` soak on the DHU.
2. **Release host allowlist**: relies on the library's sample list (the documented approach).
   A release build has only been compile/test-verified; that it really appears in a car is
   proven only by a Play internal-testing install.
3. **Location with the phone app closed**: while-in-use permission applies only when an
   activity is visible or the BLE scanner's location foreground service is running. Otherwise
   the car shows no distances (fails safe). See STATUS.
4. **expo-secure-store coupling** for the native JWT read (falls back to "Sign in on your phone").
5. **Play review**: POI category fit, and reviewers will likely see the empty state (recording
   attached per `docs/play-review-notes.md`).

## Test evidence

- `./gradlew clean` then `:app:testDebugUnitTest assembleDebug assembleRelease
  :app:lintVitalRelease :app:processReleaseManifest`: BUILD SUCCESSFUL.
- JVM tests: 89/89 pass (pure logic, Robolectric template builds, host-validator pins,
  seeded simulator scenarios driven through the real tracker, existing OdidParser tests).
- `node --test test/*.test.mjs`: 387/387. `npx tsc --noEmit`: clean.
- iOS fingerprint `3ea5e99fc169b458f4c70559607b1adb06b7ac0b`, identical to master.
- Release merged manifest: only the entries listed above; no debug receiver. Release APK
  contains no `debugsim` classes.
- DHU / car: [fill in after the morning DHU session: checklist in docs/android-auto.md,
  screenshots in docs/android-auto-screens/].

## Rollout

1. Merge. Nothing ships by itself: iOS has no change, and Android needs a native build.
2. Bump `versionCode`/`version` in a separate release commit (native change, can't be an OTA).
3. `eas build -p android --profile production` → upload to **Internal testing** → install from
   Play on a phone → check it in a real car or the DHU (release host validation).
4. Play Console: *Advanced settings → Form factors → Add Android Auto*; App access addition and
   review notes from `docs/play-review-notes.md`; attach the DHU recording.
5. Closed testing first (non-blocking Android Auto review), then production.
```

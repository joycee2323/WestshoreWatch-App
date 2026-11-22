# Android Auto: decisions log

Running log of judgment calls, blockers, and workarounds for the
`feature/android-auto` branch. Newest entries at the bottom. Times are local (EST).

---

**2026-11-21 06:00 · Branch base: `origin/master`, not local `master`.**
Local `master` was 39 commits behind `origin/master` (last fetch). Those commits
include changes to `DetectionUploader.kt`, `BLEScannerService.kt`, `OdidParser.kt`
and `app.config.js`, the exact files this feature touches. Branching from stale
local master would have produced conflicts in the files I hook into, and the
branch would have carried 39 commits that are already merged upstream.
`origin/master` was already present as a local ref, so no network call or
remote change was involved. Local `master` was not touched (no fast-forward).
Effect for review: use `git log origin/master..feature/android-auto --stat`
(or fast-forward local master first). `git log master..feature/android-auto`
would also list the 39 upstream commits.

**2026-11-21 06:00 · Separate worktree at `C:\dev\WestshoreWatch-auto`.**
The shared checkout `C:\dev\WestshoreWatch` stays on `master`, untouched, so other
sessions using it aren't disturbed. The branch lives in the main repo's `.git`,
so `git log … feature/android-auto` works from either directory.
`npm ci` ran inside the worktree only. The gitignored `google-services.json`
was copied from the main checkout so Gradle builds. It is still gitignored and
not committed.

**2026-11-21 06:10 · Wear repo used as a read-only reference.**
`WestshoreWatch-Wear` already has a native OkHttp WebSocket client (`WsManager`)
and drone registry for the same backend feed. I mirrored its patterns
(SUBSCRIBE_ORG on every open, server `last_seen` parsing, backoff) instead of
re-deriving them. No file in that repo was modified. The backend repo was also
read (read-only) to confirm the `DRONE_UPDATE` row shape and `/api/detections/recent`.

**2026-11-21 06:15 · Eviction windows: 15 s silence, 5 s grounded.**
These are the firmware defaults (`nvs_config.c`: `silent_timeout_s = 15`,
`land_timeout_s = 5`). The phone app's own stores use longer windows (BLE 30 s,
backend 60 s), which suit a map you study, not a glanceable car list. The backend
already stops broadcasting grounded drones (`groundedState`; REST excludes them
by default), so the 5 s grounded rule only matters for locally-relayed BLE frames.
For those it uses the same on-ground test as `src/services/onGround.ts`
(status 1, speed ≤ 0.5 m/s, height ≤ 3 m or unknown).

**2026-11-21 06:20 · Auth token: read expo-secure-store natively, read-only.**
The car service must work when JS has never run in this process (Android Auto can
cold-start the `CarAppService`). `UploadConfig.authToken` is in-memory only and is
populated by JS. So the car code reads the JWT the same way expo-secure-store 15.0.8
does: SharedPreferences `SecureStore`, key `key_v1-auth_token`, AES-GCM key from
AndroidKeyStore alias `AES/GCM/NoPadding:key_v1[:keystoreUnauthenticated]`. It never
writes. `UploadConfig.authToken` is the fallback. Rejected alternative: persisting
a second copy of the token from `BLEScannerModule.configure`. That doubles where the
secret lives and changes an existing code path.
Risk: this is coupled to expo-secure-store's private storage format. It's guarded
(any failure → fallback → "sign in on phone" screen) and documented in STATUS.

**2026-11-21 06:25 · No DHU / emulator available.**
The SDK has no `extras/google/auto` (DHU), no `cmdline-tools` (no `sdkmanager`), no
`system-images`, no AVDs, and `adb devices` is empty. The DHU also needs a phone
running Android Auto in developer mode ("Start head unit server"). Installing the SDK
tooling needs Android Studio's SDK Manager or a manual cmdline-tools download, and
even then a phone is still required. Decision: skip, and rely on JVM unit tests plus
a manual DHU/in-car checklist in `docs/android-auto.md`. No screenshots could be produced.

**2026-11-21 06:30 · Library version `androidx.car.app:app:1.7.0` (+ `app-projected`).**
1.7.0 is the latest stable (2025-07-16, includes the CVE-2024-10382 fix). 1.8.0 is
only at rc01. The library does not auto-merge the
`com.google.android.gms.car.application` meta-data (verified in the AARs), so we
declare it.

**2026-11-21 06:30 · Template: `PlaceListMapTemplate`, not `MapWithContentTemplate`.**
With `PlaceListMapTemplate` the host draws the map. `MapWithContentTemplate` requires
the app to render its own map onto a car Surface (Mapbox Android Auto extension or
custom rendering), which is a big, untestable-tonight dependency. `PlaceListMapTemplate`
is not deprecated in 1.7.0 and is the template Google designs for POI lists.

**2026-11-21 06:30 · Template quota strategy (the main design risk).**
The host allows 5 templates per task. `PlaceListMapTemplate` updates are free only when
the title, row count, and row titles are unchanged (or the previous template was loading,
or the update answers a user refresh). A live drone list changes membership, which
would burn quota, and the 6th counted template kills the app. Strategy:
1. Row titles are only names. Distances, ages, altitudes and speeds live in the text
   lines, which the refresh check ignores.
2. Sticky order: rows don't reorder while the set of drones is unchanged (also less
   distracting for a driver).
3. If the host reports `ConstraintManager.isAppDrivenRefreshEnabled()` (Car API 6+),
   membership changes are pushed directly. Per the API doc that does not count.
4. Otherwise membership changes are held. Existing rows keep updating (a vanished drone
   reads "signal lost"), a CarToast announces new drones, and the header refresh button
   (user-initiated refresh = free) applies them. Returning from the detail screen
   (a back operation = free) also applies them.
5. `minCarApiLevel = 5` so the refresh listener (API 5) is always available.

**2026-11-21 06:30 · Update throttle: 3 s minimum between data-driven invalidates.**
No numeric rate limit is published (checked the PlaceListMapTemplate, Screen, and
ConstraintManager sources and the quality guidelines). The brief asked for ~2–3 s,
so I used the safer end. Initial content, user refresh, and back navigation are not throttled.

**2026-11-21 06:32 · iOS fingerprint must not change.**
iOS `runtimeVersion` is `fingerprint`, which hashes the expo config (incl. the plugins
array) and every local config-plugin module. Adding `./plugins/withAndroidAuto` would
change the iOS fingerprint and stop OTA updates reaching shipped iOS builds, even
though iOS gains nothing. Fix: `fingerprint.config.js` gets `ignorePaths` for the
plugin module plus a `fileHookTransform` that removes the plugin's entry from the
`expoConfig` contents before hashing. Android is unaffected because its
runtimeVersion is a literal string. To verify: the local iOS fingerprint must stay
`3ea5e99fc169b458f4c70559607b1adb06b7ac0b` (the value measured on `origin/master`).

**2026-11-21 06:35 · Baseline release build OOMs on this machine (pre-existing).**
`assembleRelease` on unmodified `origin/master` died in `lintVitalAnalyzeRelease`
("JVM garbage collector is thrashing … out of JVM Metaspace"; configured 2 GiB heap /
512 MiB metaspace). That's an environment limit, not a code issue. Workaround: pass
`-Dorg.gradle.jvmargs="-Xmx6g -XX:MaxMetaspaceSize=1536m"` on the command line.
`gradle.properties` was NOT changed (it's committed and EAS has its own settings).
A hand-written `local.properties` with single backslashes also broke configuration
("Invalid file path"). Deleted; `ANDROID_HOME` is enough.

**2026-11-21 06:50 · Car code lives in `plugins/android/AndroidAuto/`, wired via sourceSets.**
Prebuild-safe and single-copy. The config plugin appends a generated gradle block that
adds the dir as `main.java`/`main.res`/`test.java` source sets plus the deps. The committed
`android/app/build.gradle` got the block by running the plugin's own `applyGradleBlock`, so
it's byte-identical. `test/withAndroidAuto.test.mjs` fails if they drift. Rejected:
copying sources into `android/` from the plugin (two copies that can drift), and putting
them directly in `android/app/src/main/java` (wiped by `expo prebuild --clean`).

**2026-11-21 06:55 · Operator pins = extra rows, after all drones.**
`PlaceListMapTemplate` has one marker per row, and the anchor is a single place. To show
a distinct operator pin, operators get their own rows ("Operator · name", blue "OP"
marker) while there's room under the row limit. Drones always take priority.

**2026-11-21 07:00 · Unreliable speed/heading hidden in the car.**
The backend nulls heading for legacy-decoded frames and keeps speed with a "†" note
(`kinematicsDisplay.js`: legacy speed can read ~3x high). A dagger is meaningless at a
glance and a 3x-high speed is misleading to a driver, so the car shows "—" for both unless
the frame is spec-decoded (`kinematics_reliable` from the backend; `decoder != null` for
local frames). Backends that predate the flag are treated as reliable.

**2026-11-21 07:00 · Counted-template budget = 2 on hosts without app-driven refresh.**
Quota is 5 per task: initial template (1) + detail push (1) + 1 spare leaves 2 for list
additions. Spending the budget only on ADDED drones (the event that matters) keeps the
first drone appearing automatically on old hosts. Removals never spend budget (rows show
"Signal lost").

**2026-11-21 07:00 · Rebase on `onResume`.**
Verified in the 1.7.0 sources: `ScreenManager.pop()` calls `setUseLastTemplateId(true)` on
the new top screen, so the host sees the back operation and content may change freely.
On returning from background the host is re-launched from the car launcher, which also
resets the quota.

**2026-11-21 07:05 · No alerts for drones already up when the screen opens.**
`AutoController.armAlerts()` is called after the first non-loading list. Drones from the
initial hydrate just appear in the list without a toast burst.

**2026-11-21 07:10 · Verification so far.**
JVM unit tests: 56 new + 8 existing `OdidParserTest`, all pass. JS: 371 node tests pass
(incl. 6 new), `tsc --noEmit` clean. iOS fingerprint is unchanged with the plugin:
`3ea5e99f…` (with the guard disabled it becomes `61715478…`, so the guard is what keeps it
stable). Android fingerprint is irrelevant (literal runtimeVersion).

**2026-11-21 07:25 · Added Robolectric template tests (no DHU, so this is the next-best check).**
The pure-logic tests can't catch the most likely runtime failure: the Car App Library
throwing `IllegalArgumentException` while building a template (e.g. a non-browsable
row without a `DistanceSpan`, >2 text lines, marker label >3 chars). `ScreenTemplatesTest`
uses `androidx.car.app:app-testing:1.7.0` + Robolectric 4.14.1 (`@Config(sdk = [34])`;
4.14 doesn't know SDK 36) to build the real list/detail templates. It runs with a plain
`android.app.Application`, because the real `MainApplication` boots React Native/SoLoader
under Robolectric. Two `internal` test seams were added to `AutoController`
(`originOverride`, `ingestForTest`); production code never sets them. Test-only deps
(test classpath, not in the APK).

**2026-11-21 07:25 · `setTitle`/`setHeaderAction` kept despite deprecation.**
The replacement `setHeader(Header)` is `@RequiresCarApi(7)`, and we support hosts from
API 5. Warnings are suppressed with a comment.

**2026-11-21 07:45 · Done; stopping.**
All deliverables written and committed. Final verification from a clean Gradle build is
recorded in `android-auto-STATUS.md`. No extra features started. Not done on purpose:
versionCode bump, PR, push, EAS build.

---

## Session 2 (2026-11-22, overnight)

**2026-11-22 01:00 · Task 1: rebased onto `origin/master` be505b82.**
`git fetch` showed origin/master had moved by one merge (App #36 Flight Replay:
`AppNavigator.tsx`, `DeploymentsScreen.tsx`, `FlightReplayScreen.tsx`, `api.ts`,
`flightReplay.ts`, `test/flightReplay.test.mjs`). No overlap with any file this branch
touches, so the rebase of the 3 commits was clean (no conflicts, nothing forced).
Re-verified after the rebase:
* Clean Gradle (`clean`, then `:app:testDebugUnitTest assembleDebug assembleRelease
  :app:lintVitalRelease :app:processReleaseManifest` with `-Xmx6g -XX:MaxMetaspaceSize=1536m`):
  **BUILD SUCCESSFUL** (9m27s). JVM tests 72/72.
* `node --test test/*.test.mjs`: 387/387 (371 before + Flight Replay's 16).
* `npx tsc --noEmit`: clean.
* iOS fingerprint `3ea5e99fc169b458f4c70559607b1adb06b7ac0b` (unchanged).

Environment notes: this shell had no `JAVA_HOME`. Used Android Studio's JBR
(`C:\Program Files\Android\Android Studio\jbr`, OpenJDK 21). The fingerprint must be
measured with the CLI, `npx fingerprint fingerprint:generate --platform ios` (it applies
`fingerprint.config.js`). A raw `createFingerprintAsync('.', {platforms:['ios']})` call gives a
different hash (`3bd6ce6d…`) and is NOT the check.

**2026-11-22 01:45 · Task 2: debug-only fake drone feed.**
* **Injection point: `LocalDetectionTap.onLocalDetection`**, the exact call `BLEScannerService`
  makes for real node-relayed frames. Everything downstream is the production path
  (`AutoController.ingest` → `DroneTracker`, the on-ground rule, `NewDroneAlerter`, list
  planning and quota). Rejected: calling `AutoController.ingestForTest` (skips the tap's
  on-ground conversion) or a parallel UI.
* **Release exclusion via variant source sets, not `BuildConfig.DEBUG` checks.** `src/debug`
  has `AutoDebugHooks` → `FakeDroneFeed`; `src/release` has an `AutoDebugHooks` with the same
  signature that does nothing. Release never compiles a simulator class, so there's nothing
  for R8 to keep by mistake. The gradle block (plugin + committed copy, parity-tested) adds
  `debug`, `release` and `testDebug` source dirs. The app has only those two build types.
* **Receiver registered at runtime, not in a manifest.** `FakeDroneFeed` registers it
  (`ContextCompat.registerReceiver`, `RECEIVER_EXPORTED` so `adb shell` can reach it) when the
  first car session starts. A debug-manifest receiver would have meant editing the committed
  `android/app/src/debug/AndroidManifest.xml` and a second (dangerous-mod) plugin step to keep
  prebuild-safe; the runtime receiver needs no manifest at all, so the release merged manifest
  can't contain it. Cost: broadcasts only work after the car app has been opened once in the
  process (documented).
* **Scenario timing:** frames at 1 Hz (typical Remote ID rate). `landing` touches down at 40 s
  and keeps sending on-ground frames until 90 s, to prove the drone stays suppressed rather
  than flickering back. `silent` stops at 30 s. `churn` uses 3 slots, lives and gaps 20–40 s,
  15 min total (≥ 40 membership changes, tested).
* **Origin:** the controller's phone fix at scenario start, else Brook Park, OH
  (41.3984, -81.8046, approx. city center).
* **Generators are pure and seeded** (`kotlin.random.Random(seed)`, default 42), with tests in
  `src/testDebug` (8 tests; they run in `testDebugUnitTest`). They can't live in `src/test`
  because that's also compiled for `testReleaseUnitTest`, where the simulator doesn't exist.

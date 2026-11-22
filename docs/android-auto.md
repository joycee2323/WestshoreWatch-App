# Android Auto (phone app)

Android Auto support for Westshore Watch: a **POI-category** car app that shows live
drone detections on a host-drawn map, with a detail screen and "navigate to drone /
operator". Android only. Phase 1 research is in `android-auto-investigation.md`, and
every judgment call is in `android-auto-decisions.md`.

---

## Architecture

```
            Android Auto host (car / DHU)
                     │ binds (only while projecting)
                     ▼
   WswCarAppService ──► DroneSession ──► AutoController (per session, main thread)
   (category POI)                         │   ├─ AutoFeed ── OkHttp WS /ws (SUBSCRIBE_ORG)
                                          │   │              + REST /api/detections/recent?minutes=1
                                          │   ├─ LocalDetectionTap ◄── BLEScannerService (1 line)
                                          │   ├─ PhoneLocation (LocationManager, fused)
                                          │   ├─ DroneTracker (merge + 15 s / 5 s eviction)
                                          │   └─ NewDroneAlerter (CarToast batching)
                                          ▼
                     DroneListScreen (PlaceListMapTemplate)
                         │ tap row
                         ▼
                     DroneDetailScreen (PaneTemplate) ── Navigate → geo: via startCarApp
```

### Where the code lives (and why)

| Path | What |
|---|---|
| `plugins/android/AndroidAuto/src/main/java/com/westshoredrone/watch/auto/` | All car Kotlin (package `com.westshoredrone.watch.auto`) |
| `plugins/android/AndroidAuto/src/main/res/xml/automotive_app_desc.xml` | `<uses name="template"/>` |
| `plugins/android/AndroidAuto/src/test/java/...` | JVM unit tests: 56 pure-logic + 8 Robolectric template tests (`ScreenTemplatesTest` builds the real templates so the library's validation runs) |
| `plugins/withAndroidAuto.js` | Expo config plugin: manifest entries + a generated gradle block that adds the dirs above as source sets and the `androidx.car.app` deps. Idempotent. |
| `android/app/build.gradle`, `android/app/src/main/AndroidManifest.xml` | The same edits, committed (android/ is committed and isn't regenerated today). `test/withAndroidAuto.test.mjs` fails if they drift from the plugin. |
| `android/.../BLEScannerService.kt` | One call to `LocalDetectionTap.onLocalDetection(...)` after `enqueue()` |
| `fingerprint.config.js` | Keeps the Android-only plugin out of the **iOS** fingerprint |

The car code lives outside `android/` so that a future `expo prebuild --clean` cannot wipe it.

### Files

* `WswCarAppService.kt`: entry point. `createHostValidator`: allow all hosts in debuggable
  builds, Google's `hosts_allowlist_sample` in release. Creates `DroneSession`.
* `AutoController.kt`: session lifecycle observer. Starts the feed, local tap and location
  on `onStart` (car screen visible), stops them on `onStop`. 1 s ticker for eviction and
  "seen N s ago" text.
* `AutoFeed.kt`: native WS + REST hydrate, read-only. Status: `SIGNED_OUT / CONNECTING /
  CONNECTED / OFFLINE`.
* `AuthTokenProvider.kt`: JWT from expo-secure-store (read-only native decrypt) →
  fallback `UploadConfig.authToken`.
* `DroneTracker.kt`: merge by UAS ID. 15 s silence and 5 s continuously-grounded eviction
  (firmware defaults). Grounded drones stay suppressed until airborne (no flicker).
  Legacy-decoded speed and heading are hidden.
* `ListPlanner.kt`: row planning (nearest first, sticky order, drones before operators,
  row limit), `ListRefreshPolicy` (template quota), `RefreshThrottle` (3 s),
  `NewDroneAlerter`.
* `BackendParser.kt`: WS `DRONE_UPDATE` / REST rows → observations.
* `Geo.kt`: haversine, bearing, cardinal, `geo:` URI, imperial formatting identical to
  `src/utils/units.ts` (AGL only, never HAE).
* `DroneListScreen.kt`, `DroneDetailScreen.kt`: templates.

---

## Screens

**Main ("Live drones", `PlaceListMapTemplate`)**
* Map: host-drawn, with the car/phone position (`setCurrentLocationEnabled` when
  permitted). Red pins for drones, grey for grounded or lost, blue "OP" pins for operators.
* Rows (≤ host limit, usually 6): drones nearest first, then operator rows while room remains.
  * Title: nickname or UAS ID (operator rows: "Operator · name").
  * Line 1: `[distance] · NE · 120 ft AGL · 22.4 mph`. Distance is a `DistanceSpan`, so
    the host formats it. Local-only frames show "ft high" (height above takeoff), never HAE.
  * Line 2: `Seen 3 s ago`, `NEW · Seen now` (red "NEW" for the first 30 s),
    `On ground · …`, or `Signal lost`.
* Empty state: "No drones detected · Live feed connected" (or connecting / offline, plus
  "· Location off").
* Header refresh button (user refresh, which never counts against quota).
* "Allow location" action when phone location permission is missing. It opens the
  phone permission prompt via `CarContext.requestPermissions`.
* Signed out / token rejected: `MessageTemplate` "Sign in on your phone", with a
  "Try again" action.

**Detail (`PaneTemplate`)**, title = drone name. Rows: Position (distance, direction, seen
age / signal lost), Altitude · speed · heading, Operator (distance, or "Not broadcast"),
Remote ID. Actions: **Navigate to drone** (primary) and **Navigate to operator** (only
when the operator position is known). Both launch the car's navigation app with
`geo:lat,lon` through `CarContext.startCarApp(ACTION_NAVIGATE)`.

### Live updates and the 5-template quota

* Data-driven redraws are throttled to one per **3 s** (no official number exists; the brief
  asked for 2–3 s).
* Row titles hold only names. Distances and ages change in the text lines, which the host's
  refresh check ignores, so moving drones are free refreshes.
* Rows keep their order while the same drones are listed (sticky). The list re-sorts when
  the set changes, on user refresh, and on return from the detail screen.
* When the host supports **app-driven refresh** (Car API 6+), membership changes go
  straight through.
* On older hosts, a new drone may use one of **2** counted templates. After that, rows
  freeze: vanished drones show "Signal lost", new drones trigger a toast ending
  "Tap refresh to show", and the refresh button or returning from a detail screen applies them.
* New-drone alerts are batched `CarToast`s, at most one per 10 s ("New drone: X" /
  "3 new drones detected"), with no sound. Drones already in the air when the screen
  opens don't trigger a toast.

---

## Building

Nothing special: `cd android && ./gradlew assembleDebug` / `assembleRelease`.
On this workstation the default Gradle heap (2 GiB / 512 MiB metaspace in
`gradle.properties`) runs out of metaspace during `lintVitalAnalyzeRelease`, on master too.
Pass more memory on the command line:

```
./gradlew assembleRelease "-Dorg.gradle.jvmargs=-Xmx6g -XX:MaxMetaspaceSize=1536m"
```

Tests:
```
cd android && ./gradlew :app:testDebugUnitTest      # JVM tests (car logic + OdidParser)
node --test test/*.test.mjs                          # JS tests incl. plugin/fingerprint guard
npx tsc --noEmit
```

---

## Running on the Desktop Head Unit (DHU)

**Already installed on this workstation (2026-11-22):** Android SDK Command-line Tools
23.0 at `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest\` and the **DHU 2.0** (stable
channel) at `%LOCALAPPDATA%\Android\Sdk\extras\googleuto\desktop-head-unit.exe`.
To reinstall or update it (PowerShell):

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
# The new `android` CLI (sdkmanager.bat now forwards to it). Package paths use "/":
# the old "extras;google;auto" form gets split at the ";" by the .bat wrapper.
& "$sdk\cmdline-tools\latestinndroid.exe" --sdk=$sdk sdk install extras/google/auto
# DHU 2.1 is on the beta channel only:  ... sdk install --beta extras/google/auto
```

What you need to do yourself (a physical phone is required; the DHU is only the car's screen):

1. Phone (Android 9+) with **Android Auto** installed and updated (Play Store sign-in).
   On Android 10+ it's built in: *Settings → Connected devices → Connection preferences →
   Android Auto*.
2. Android Auto settings → scroll to **Version** → tap it 10× → developer mode on. Overflow
   menu (⋮) → **Start head unit server**. Also turn on
   *Previously connected cars → Add new cars to Android Auto* if it's off.
3. Plug the phone in over USB (USB debugging on, the PC's key accepted).
4. Install a **debug** build (debug builds accept any host via `ALLOW_ALL_HOSTS_VALIDATOR`;
   a release build only binds to Google-signed hosts, and Car App Library apps ignore
   Android Auto's "unknown sources" toggle, so test release builds via Play internal testing):

   ```powershell
   cd C:\dev\WestshoreWatch-auto
   adb install -r androidppuild\outputspk\debugpp-debug.apk
   # or build + install + Metro in one go:  npx expo run:android
   ```

   A debug APK needs Metro for the phone UI (`npx expo start` in the worktree, then
   `adb reverse tcp:8081 tcp:8081`). The car screens are native and don't need Metro, but
   signing in does.
5. Open the phone app once and **sign in** (and grant location).
6. Start the DHU:

   ```powershell
   adb forward tcp:5277 tcp:5277
   & "$env:LOCALAPPDATA\Android\Sdk\extras\googleuto\desktop-head-unit.exe"
   ```

   (Alternative without the head unit server: `adb kill-server`, then
   `desktop-head-unit.exe --usb` with the phone in USB accessory mode.)
7. In the DHU launcher, open **Westshore Watch**.
8. Useful logcat tags: `adb logcat -s WswAutoSim WswAutoFeed WswAutoAuth WswAutoLocation WswAutoDetail CarApp.H CarApp`.

Screenshots for review/store: type `screenshot C:\pathile.png` in the DHU console window.

To test with no real drones, use the debug-build simulator (next section). The
over-the-air tools in this workspace (`wsw-skydio-sim-tx`, `wsw-frozen-sim-tx`) still exist
for an end-to-end BLE → node → backend → WS test, but they need node hardware.

---

## Testing without real drones (debug builds only)

Debug builds contain a fake-drone simulator (`plugins/android/AndroidAuto/src/debug/…/debugsim/`).
It feeds frames into `LocalDetectionTap`, the same entry point as real node-relayed BLE frames,
so they go through the real `AutoController` → `DroneTracker` (eviction, on-ground rule,
new-drone toasts, quota policy). There is no separate UI.

**Release builds contain none of it.** The release source set has an empty `AutoDebugHooks`
with the same signature. No receiver is declared in any manifest; the debug code registers
it at runtime.

**How to drive it.** Open Westshore Watch on the DHU first. The receiver is registered when
the first car session starts. A broadcast sent earlier is simply not received; open the car
app and send it again. Then, from a terminal on the PC:

```
adb shell am broadcast -a com.westshoredrone.watch.auto.DEBUG_SIM --es scenario one     -p com.westshoredrone.watch
adb shell am broadcast -a com.westshoredrone.watch.auto.DEBUG_SIM --es scenario many    -p com.westshoredrone.watch
adb shell am broadcast -a com.westshoredrone.watch.auto.DEBUG_SIM --es scenario churn   -p com.westshoredrone.watch
adb shell am broadcast -a com.westshoredrone.watch.auto.DEBUG_SIM --es scenario landing -p com.westshoredrone.watch
adb shell am broadcast -a com.westshoredrone.watch.auto.DEBUG_SIM --es scenario silent  -p com.westshoredrone.watch
adb shell am broadcast -a com.westshoredrone.watch.auto.DEBUG_SIM --es scenario stop    -p com.westshoredrone.watch
```

Optional: `--el seed 7` changes the random layout of `many`/`churn` (default seed 42, so the
same command always gives the same drones). Watch `adb logcat -s WswAutoSim` for what it's doing.

| Scenario | What happens | What to check |
|---|---|---|
| `one` | `SIM-ONE-1` circles the phone at 300 m (60 m high, ~12.6 m/s = 28 mph), operator 140 m SW. Runs until `stop`. | Row shows ~300 m (~0.19 mi), direction changes, 197 ft "high", 28.1 mph; OP row/pin; detail + Navigate. |
| `many` | 8 drones (`SIM-MANY-1..8`) on orbits 200 m – 1.6 km away, each operator at its orbit center. Runs until `stop`. | List caps at the host limit (usually 6), nearest first, operators dropped first. |
| `churn` | 3 slots; each runs a drone for 20–40 s (new UAS ID each time), then a 20–40 s gap. 15 minutes, then stops by itself. | **Quota soak**: no "app ran into an error" for the full 15 min; toasts are batched; on older hosts rows freeze and refresh applies them. |
| `landing` | `SIM-LAND-1` 400 m east: level at 60 m for 10 s, descends 2 m/s, touches down at 40 s, keeps transmitting on the ground until 90 s. | Row disappears ~5 s after touchdown (t ≈ 45 s) and does **not** come back while it sits on the ground. |
| `silent` | `SIM-SILENT-1` circles at 250 m for 30 s, then stops transmitting. | "Seen N s ago" grows, then the drone is dropped ~15 s after the last frame (t ≈ 45 s); on an older host the row may show "Signal lost" until refresh. |
| `stop` | Stops sending. Drones age out by the normal 15 s rule. | |

Starting a new scenario replaces the current one (its drones age out). The scenario keeps
its clock while the car screen is hidden and resumes when it's shown. Frames are sent only
while a car session is started.

**Where it's centered:** the phone's last location fix if the car app has one, otherwise
a fixed point in Brook Park, OH (41.3984, -81.8046). With the Brook Park fallback the
distances are from Brook Park to wherever the map thinks you are. Grant location for
meaningful distances.

**Signed out?** The car shows "Sign in on your phone" and no list, simulator or not. Sign in first.

Unit tests: `plugins/android/AndroidAuto/src/testDebug/…/SimScenariosTest.kt` (runs in
`:app:testDebugUnitTest`) checks each generator deterministically (seeded) and drives `landing`
and `silent` through the real `DroneTracker` to prove the 5 s / 15 s evictions.

---

## Manual test checklist (DHU first, then a real car)

Setup: debug build, phone signed in, location granted. Drones come from the debug
simulator (`adb shell am broadcast … --es scenario <name>`, see "Testing without real
drones"); the scenario to use is given in brackets.

**Launch / auth**
- [ ] App appears in the Android Auto launcher with the Westshore icon and name.
- [ ] First open with the phone app **killed** (swipe away): the list loads within ~4 s
      (DR-2/DR-3: ≤ 10 s). This proves the JWT is read without JS.
- [ ] Sign out on the phone, then open the car app: "Sign in on your phone". Sign in on
      the phone. Within ~10 s, or after "Try again", the list appears.
- [ ] Expired token (or revoke the session server-side): the car shows "Sign in on your
      phone", not a crash or an empty list.

**Main list**
- [ ] No drones: "No drones detected · Live feed connected".
- [ ] Airplane mode on the phone: the message changes to "offline, retrying". Turning
      airplane mode off reconnects.
- [ ] [`one`] The drone appears within ~3 s of the broadcast. Toast "New drone: SIM-ONE-1".
      The row shows "NEW" for 30 s. (With a real node, also check it appears within a few
      seconds of the phone Live Map showing it.)
- [ ] [`one`] The row shows distance, direction, height, mph. Values update about every 3 s
      and the rows **don't jump** while the set is unchanged.
- [ ] [`one`] The map shows a red drone pin and a blue "OP" operator row/pin.
- [ ] [`landing`] The drone leaves ~5 s after touchdown (t ≈ 45 s) and stays gone.
- [ ] [`silent`] The drone leaves ~15 s after it stops (t ≈ 45 s). On an older host it may
      show "Signal lost" until refresh.
- [ ] [`many`] 8 drones: the list caps at the host limit. Nearest drones are listed and
      operators are dropped first.
- [ ] [`churn`, 15 min] Leave the screen open with drones coming and going: the app
      **never** shows the host's "app ran into an error" / quota message. (The main risk; see
      Known limitations.) Also open a detail screen and go back a few times during the run.
- [ ] Header refresh button applies pending changes.
- [ ] Revoke location permission on the phone: no distances, rows still tappable, an
      "Allow location" action is shown, and tapping it opens the phone prompt.

**Detail**
- [ ] Tap a drone: the pane shows Position, Altitude · speed · heading, Operator, Remote ID.
- [ ] Values update live. [`silent`, open the detail before t = 30 s] When it goes silent:
      "Signal lost · last seen N s ago", and Navigate still works.
- [ ] **Navigate to drone** opens Google Maps (or the default nav app) to the drone's position.
- [ ] **Navigate to operator** appears only when the operator position is known, and navigates there.
- [ ] Back returns to the list with current data (no error).

**Regression (phone app)**
- [ ] With Android Auto **not** connected: BLE scanning, uploads, Live Map, notifications
      and the Wear bridge all behave as before. (The tap is a no-op without a car session.)
- [ ] Release build launches and scans normally (R8/minify enabled).

---

## Known limitations

* **Not run on a DHU or a car yet.** Everything is verified by unit tests (including
  Robolectric tests that build the real templates through the library's validation),
  compile, lint-vital and the merged manifest only. See `android-auto-STATUS.md`.
* **Template quota on older hosts.** If a host lacks app-driven refresh, list membership
  changes after the first two need the refresh button (or a trip to the detail screen and
  back). If real hosts count updates differently than the documented rules, the app could
  still hit the 5-template limit. The checklist's 10-minute soak test covers this.
* **Local BLE tap only while scanning.** It feeds the car only while the phone app's BLE
  foreground service is running (started from the phone's Live Map). Without it, the car
  relies on the backend feed, which needs cellular data.
* **Location while backgrounded.** Uses foreground location permission. Whether Android
  grants it while only the car screen is visible (phone app UI closed) hasn't been verified
  on a device. If not, distances fall back to the last known fix or are hidden.
* **Token format coupling.** The native JWT read mirrors expo-secure-store 15.0.8's private
  storage format. An expo-secure-store upgrade that changes it degrades to the in-memory
  `UploadConfig` token (needs the phone app opened once per process). Re-run the
  "phone app killed" checklist item after upgrading expo-secure-store.
* **No heads-up car notifications.** New drones are announced only while the car app is on
  screen (CarToast). A `CarAppExtender` notification for drones detected while the
  driver is in Maps would be a follow-up. It needs care with IN-1 (relevant notifications only).
* **Scope = every drone the user's org can see** (`SUBSCRIBE_ORG`, like the Wear app and
  the phone's passive map), not the phone's current deployment selection.
* Light/dark map styling is the host's (MR-1 applies only to app-drawn maps).

---

## Google Play Console checklist (to ship)

Prerequisites in the repo (not done on this branch, on purpose):
1. Bump `versionCode` (android/app/build.gradle + app.config.js) and `version` as usual for a
   native release. This is a **native** change; it can't ship as an OTA.
2. Build the production AAB with EAS as usual (`eas build -p android --profile production`).

In Play Console:
3. **Internal testing first.** Upload the AAB to an *Internal testing* track. There's no
   form-factor review there, and it's the only practical way to run a release build in a
   real car (Car App Library apps ignore Android Auto's "unknown sources" toggle).
4. **Opt in to Android Auto:** *Test and release → Advanced settings → Form factors →
   Add form factor → Android Auto*. It requires that an Android Auto-capable bundle has
   been released to a testing track (step 3). Accept the Android Auto terms shown.
5. **App access:** keep the existing reviewer test account in *Policy → App content → App
   access*, and add a line that the car app needs the phone app signed in first ("Open
   the phone app, sign in with the credentials above, then open Westshore Watch in
   Android Auto").
6. **Review notes for the Android Auto submission.** Explain that the app is a
   point-of-interest app for public-safety / venue drone awareness. POIs are live
   Remote ID drone positions and their operators, and the app offers navigation to them.
   Reviewers will most likely see the **empty state** (no drones near them). Say so, and
   attach a short screen recording from the DHU showing live drones plus the detail and
   navigate flow. (Gotcha: an app that "does nothing" in review can fail PF-1, meaningful
   functionality.)
7. **Screenshots.** Capture from the DHU (main list with drones, detail pane, empty
   state, no OEM branding). Add them where Play Console asks for Android Auto screenshots
   if it does for your listing. AAOS-only rules (2 portrait 800×1280 + 2 landscape
   1024×768) don't apply to Android Auto.
8. **Data safety.** No new data types: location was already collected for the map; the car
   app reads the same detections as the phone. Re-confirm the form doesn't need changes.
9. **Promote.** Closed testing gives a non-blocking Android Auto review (you get findings
   without being rejected), which is a good dry run. Open testing and production reviews
   are blocking.

Review gotchas (from the quality guidelines):
* PC-1 (permitted categories). The POI category is meant for places like parking and
  charging. Reviewers might question live drone positions as POIs, so the review notes
  (step 6) should frame them as safety-relevant locations a driver navigates to.
* AC-1 (≤ 5 screens per task): we use 2. DR-1/2/3 (response ≤ 2 s, launch/content ≤ 10 s):
  the list shows within ~4 s, or immediately on cached data.
* ST-1 / SA-1: no scrolling text, no animation. IN-1 / NA-1: no notifications are posted by
  the car app.
* If the app isn't available in the US, reviewers need to be allowed a mock GPS location.

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

1. Android Studio → SDK Manager → SDK Tools → check **Android Auto Desktop Head Unit
   Emulator** → it installs to `%LOCALAPPDATA%\Android\Sdk\extras\google\auto\`.
2. Phone (Android 9+) with **Android Auto** installed and updated (Play Store sign-in).
3. Android Auto settings → About → tap **Version and permission info** 10× → developer
   mode. Overflow menu → **Start head unit server**. Also enable
   *Settings → Previously connected cars → Add new cars to Android Auto*.
4. Install a **debug** build on the phone (`npx expo run:android` or
   `adb install app-debug.apk`). Debug builds accept any host (`ALLOW_ALL_HOSTS_VALIDATOR`).
   A release build only accepts Google's real hosts. The DHU talks to the real Android Auto
   app, so release builds also work, but only if installed from Play (see below).
5. Open the phone app once and **sign in** (and grant location).
6. `adb forward tcp:5277 tcp:5277`, then run
   `%LOCALAPPDATA%\Android\Sdk\extras\google\auto\desktop-head-unit.exe`
   (or `desktop-head-unit.exe --usb` after `adb kill-server`).
7. In the DHU launcher, open **Westshore Watch**.
8. Useful logcat tags: `WswAutoFeed`, `WswAutoAuth`, `WswAutoLocation`, `WswAutoDetail`,
   `CarApp.H`/`CarApp` (library + host).

To test with no real drones, the existing tools in this workspace (`wsw-skydio-sim-tx`,
`wsw-frozen-sim-tx`) generate Remote ID broadcasts a node will relay. They exercise the
whole BLE → backend → WS path.

Screenshots for review/store: the DHU has a screenshot command in its console (`screenshot
<file.png>`).

---

## Manual test checklist (DHU first, then a real car)

Setup: debug build, phone signed in, location granted, a node relaying a simulated or
real drone.

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
- [ ] A drone appears within a few seconds of the phone Live Map showing it. Toast
      "New drone: …". The row shows "NEW" for 30 s.
- [ ] The row shows distance, direction, AGL, mph. Values update about every 3 s and the
      rows **don't jump** while the set is unchanged.
- [ ] The map shows a red drone pin and, if broadcast, a blue "OP" operator row/pin.
- [ ] The drone lands or stops: it leaves within ~15 s (backend) / 5 s grounded (local
      relay). On an older host it may show "Signal lost" until refresh.
- [ ] 7+ drones (simulator): the list caps at the host limit. Nearest drones are listed and
      operators are dropped first.
- [ ] Leave the screen open for 10+ minutes with drones coming and going: the app **never**
      shows the host's "app ran into an error" / quota message. (The main risk; see Known
      limitations.)
- [ ] Header refresh button applies pending changes.
- [ ] Revoke location permission on the phone: no distances, rows still tappable, an
      "Allow location" action is shown, and tapping it opens the phone prompt.

**Detail**
- [ ] Tap a drone: the pane shows Position, Altitude · speed · heading, Operator, Remote ID.
- [ ] Values update live. If the drone goes silent: "Signal lost · last seen N s ago",
      and Navigate still works.
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

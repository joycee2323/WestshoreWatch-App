# Android Auto: Phase 1 investigation

Date: 2026-11-21. Branch: `feature/android-auto` (based on `origin/master` 3e36b74c).
Scope: Android Auto (projected) only. No CarPlay, no Android Automotive OS build.

---

## 1. How detections flow today (codebase)

### 1a. Native BLE relay path (Android)

`BLEScannerService` (foreground service, `connectedDevice|location`) scans for ODID
service-data adverts (UUID `0xFFFA`) relayed by Westshore nodes:

1. `onScanResult` → `emitScanResult` (to JS, if a React context is alive) and
   `maybeEnqueueForUpload`.
2. `maybeEnqueueForUpload` parses with `OdidParser.parseServiceData`, drops idle-node
   beacons (`WSW-…`), uses Pack-only attribution (legacy per-message frames are dropped),
   requires the source MAC to be a recognized Westshore node (identity advert `0x08FE`),
   requires a valid position, then calls
   `DetectionUploader.enqueue(deviceId, DroneRecord(...))`.
3. `DetectionUploader` coalesces per node and uas id and flushes every 500 ms:
   `POST {base}/api/nodes/{deviceId}/detections`, `Authorization: Bearer <JWT>`.
   Body: `{drones:[{id, lat, lon, alt, spd, hdg, op_lat, op_lon, ts, status, height, vspd,
   decoder?, loc_raw?}]}`.
   Note: the upload payload has **no `nickname`**. Nicknames are per-org on the backend
   and only appear on rows coming back from the backend.
4. The JWT and base URL come from `UploadConfig` (an in-memory `object`), which JS fills via
   `BLEScanner.configure()` from `authStore.loadToken()/login()` and clears on logout.

Native keeps **no detection store**. The uploader queue is drained every 500 ms, and
nothing else holds detections natively.

### 1b. JS paths

* `src/services/bleScanner.ts` subscribes to `BLEScanResult` events. It feeds
  `droneStore.bleDrones` (guest mode), the node-less relay upload
  (`detectionUploader.ts`), and the local "New Drone Detected" fallback (`droneNotifier.ts`).
* **Backend live feed:** `LiveMapScreen` calls `createWebSocket()` (`src/services/api.ts`),
  `wss://api.westshoredrone.com/ws?token=<JWT>`, then either
  `SUBSCRIBE {deployment_ids}` (active mode) or `SUBSCRIBE_ORG` (passive mode).
  `DRONE_UPDATE` rows go into `droneStore.backendDrones`, keyed `${deployment_id}:${uas_id}`.
  There's an ack-gated subscribe retry (the edge can drop the first frame) and a 30 s
  app-level `PING`.
* **REST:** `GET /api/detections/{deploymentId}` and `GET /api/detections/recent?minutes=N`
  (1–60). Grounded drones are excluded by default.
* Backend row fields (read from the backend source, read-only): `uas_id, last_lat, last_lon,
  last_altitude (HAE), alt_agl_m, last_speed, last_heading, op_lat, op_lon, last_seen
  (ISO), nickname, deployment_id, kinematics_reliable` (+ node fields, redacted cross-org).
  DECIMAL columns arrive as strings over REST.
* **Staleness:** `droneStore` sweeps BLE entries after 30 s and backend entries 60 s past
  `last_seen`. The node firmware defaults are `silent_timeout_s = 15` and
  `land_timeout_s = 5` (`nvs_config.c`). The backend stops broadcasting grounded drones
  (`services/groundedState.js`) and nulls heading for legacy-decoded frames
  (`services/kinematicsDisplay.js`).
* **Map:** `@rnmapbox/maps` in `LiveMapScreen`. Not usable on the car screen: Android Auto
  templates either use a host-drawn map (`PlaceListMapTemplate`) or require the app to
  draw into a car `Surface`.

### 1c. Can native code read detection state without JS?

**No.** All live state (`backendDrones`, `bleDrones`, nicknames) lives in zustand stores
in the JS heap. A `CarAppService` bind does not start the React runtime (`MainApplication`
only starts React when an Activity/`ReactHost` is created). The only native pieces are
the transient upload queue and the in-memory `UploadConfig.authToken`. That token is
**null after a process cold start until JS runs**.

### 1d. User location

JS-only today: `expo-location` in `LiveMapScreen` (`requestForegroundPermissionsAsync`,
`getLastKnownPositionAsync`, `getCurrentPositionAsync`). The manifest already declares
`ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION`. No native location code exists apart from
BLE scanning's location requirement.

### 1e. Auth

JWT stored in expo-secure-store under `auth_token` (`authStore.ts`). On Android
(expo-secure-store 15.0.8) that's SharedPreferences `SecureStore`, key
`key_v1-auth_token`, value `{ct, iv, tlen, scheme:"aes", usesKeystoreSuffix, …}`, encrypted
with AES-GCM under AndroidKeyStore alias
`AES/GCM/NoPadding:key_v1:keystoreUnauthenticated`.

---

## 2. Android for Cars App Library research

| Topic | Finding | Source |
|---|---|---|
| Latest stable | `androidx.car.app:app` **1.7.0** (2025-07-16; first stable with the CVE-2024-10382 fix). 1.8.0 is rc01 (2026-08-26), 1.9.0 alpha03. | https://developer.android.com/jetpack/androidx/releases/car-app |
| Artifacts | `app` (core) + `app-projected` (Android Auto). `app-automotive` only for AAOS. | same |
| POI category | `<category android:name="androidx.car.app.category.POI"/>` in the `CarAppService` intent filter. PARKING/CHARGING are deprecated in favor of POI. | https://developer.android.com/training/cars/apps/poi |
| Map permission | `<uses-permission android:name="androidx.car.app.MAP_TEMPLATES"/>`. `PlaceListMapTemplate` is only for POI (and the deprecated PARKING/CHARGING) apps. | same |
| PlaceListMapTemplate | Host-drawn map + list of places. Rows carry a `Place` (`CarLocation` + `PlaceMarker`) via `Row.Builder.setMetadata`. Max 2 text lines per row. **Every non-browsable row must carry a `DistanceSpan`.** No large images. List size ≤ `ConstraintManager.CONTENT_LIMIT_TYPE_PLACE_LIST` (fallback resource = 6). `setCurrentLocationEnabled` needs FINE/COARSE location. `setLoading(true)` XOR a list. Not deprecated in 1.7.0. | https://developer.android.com/reference/androidx/car/app/model/PlaceListMapTemplate (and library 1.7.0 sources) |
| MapWithContentTemplate | Lists/content beside a map **rendered by the app** (Surface). It replaces the deprecated navigation map templates (API 7). | https://developer.android.com/training/cars/apps/poi, https://developer.android.com/training/cars/apps/navigation |
| PlaceMarker | Icon (64 dp) or label (≤ 3 chars) + tint color. | https://developer.android.com/reference/androidx/car/app/model/PlaceMarker |
| Template quota | "The host limits the number of templates to display for a given task to a maximum of five". Exceeding it: "the host displays an error message to the user before closing the app." Back operations restore quota. A launcher or notification intent resets it. | https://developer.android.com/training/cars/apps/library/template-restrictions |
| What counts as a refresh | PlaceListMapTemplate/PaneTemplate: previous template was loading, OR title unchanged AND row count + every row title (ignoring spans) unchanged, OR (PlaceList) the update answers the user's refresh button (`setOnContentRefreshListener`, Car API 5). "As long as the next template returned by `onGetTemplate` is of the same type, it is counted as a refresh" (POI page wording; the reference javadoc is stricter, and we follow the stricter rule). | PlaceListMapTemplate / PaneTemplate javadoc; https://developer.android.com/training/cars/apps/poi |
| App-driven refresh | `ConstraintManager.isAppDrivenRefreshEnabled()` (Car API 6): "enables applications to refresh lists content without being counted towards a step." | library 1.7.0 sources, `ConstraintManager.java` |
| Update rate limit | **No numeric limit published** (checked the reference pages, the template-restrictions page, the quality guidelines and the library sources). | sources above |
| Content limits | `getContentLimit(CONTENT_LIMIT_TYPE_PLACE_LIST)` from the host. Library fallbacks: list 6, place list 6, pane 4, grid 6, route list 3. | library 1.7.0 `res/values` + `ConstraintManager.java` |
| Manifest | Exported `CarAppService` with action `androidx.car.app.CarAppService` + category. `androidx.car.app.minCarApiLevel` meta-data in `<application>`. Android Auto needs `com.google.android.gms.car.application` → `@xml/automotive_app_desc` (`<automotiveApp><uses name="template"/></automotiveApp>`). **Not merged by the library AARs** (verified: neither `app` nor `app-projected` manifests contain it). | https://developer.android.com/training/cars/apps/library/set-up-project, https://developer.android.com/training/cars/apps/automotive-os |
| Host validation | Override `createHostValidator()`. Use `ALLOW_ALL_HOSTS_VALIDATOR` only in debug builds. In release: `HostValidator.Builder(ctx).addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)`. | `CarAppService.createHostValidator` javadoc (1.7.0 sources) |
| Navigation | `carContext.startCarApp(Intent(CarContext.ACTION_NAVIGATE, Uri.parse("geo:12.345,14.8767")))`. Also accepted: `geo:0,0?q=address`. | `CarContext.startCarApp` javadoc (1.7.0 sources) |
| Toasts | `CarToast.makeText(carContext, text, LENGTH_SHORT/LONG).show()`. No sound. | `CarToast.java` |
| Car-side alerts | `Alert`/`AppManager.showAlert` only within `NavigationTemplate` (navigation apps). | https://developer.android.com/training/cars/apps/navigation |
| Quality (POI) | AC-1 tasks in ≤ 5 screens. DR-1 buttons respond ≤ 2 s. DR-2 launch ≤ 10 s. DR-3 load content ≤ 10 s. ST-1 no auto-scrolling text. SA-1 no animation. IN-1 notifications only when relevant. NA-1 no ad notifications. PF-1 meaningful driving-relevant functionality. MR-1 light/dark maps (app-drawn maps only). | https://developer.android.com/docs/quality-guidelines/car-app-quality |
| Distribution | Play Console → Advanced settings → Form factors → **Add form factor → Android Auto**. Requires an Android Auto bundle released to a testing track. Review: internal sharing/internal testing none, closed testing non-blocking, open/production blocking. Car App Library apps are **not** covered by Android Auto's "unknown sources" developer toggle, so real-car testing needs a Play track (internal testing works). If the app isn't US-available, reviewers need mock GPS allowed. | https://developer.android.com/training/cars/distribute, https://developer.android.com/training/cars/testing |
| DHU | SDK Manager → SDK Tools → "Android Auto Desktop Head Unit Emulator" → `SDK/extras/google/auto/`. Phone (API 28+) with Android Auto, developer mode (tap "Version and permission info" 10x), overflow → "Start head unit server", `adb forward tcp:5277 tcp:5277`, run `desktop-head-unit.exe` (or `--usb`). | https://developer.android.com/training/cars/testing/dhu |

---

## 3. Approach: native Kotlin vs react-native-carplay

**Options**

* **(a) Native Kotlin `CarAppService`** in the existing Android project, fed by a native
  data path.
* **(b) `react-native-carplay`** (birkir). The upstream README now claims Android Auto support
  (min API 30) alongside CarPlay. As of a mid-2025 index snapshot, the last push was
  February 2025 with ~54 open issues. New Architecture support is claimed only by a
  third-party fork (`@g4rb4g3/react-native-carplay`, "RN 0.76+, Expo 53"), not by
  upstream. No evidence of RN 0.81 / Expo 54 compatibility. Alternatives such as
  `@iternio/react-native-auto-play` exist but are young.
  Sources: https://www.github.com/birkir/react-native-carplay,
  https://cdn.jsdelivr.net/npm/@g4rb4g3/react-native-carplay@2.7.22/README.md,
  https://www.pkgstats.com/pkg:@iternio/react-native-auto-play

**Decision: (a) native Kotlin.**

1. The car screen must work with no JS runtime. Android Auto can cold-start the
   `CarAppService` with no Activity. (b) drives templates from JS, so it needs the React
   runtime booted and alive in the background, which this app doesn't do.
2. (b) has unclear New Architecture / RN 0.81 status upstream. Relying on a fork in a
   production app with a committed bare `android/` is a maintenance risk.
3. The app already ships hand-written Kotlin (BLE service, uploader, WearBridge), and
   the Wear app has a native WS client for the same feed to mirror.
4. We only need two templates (place list + pane). The Car App Library surface is small
   and well-documented, so a JS abstraction gains little.
5. iOS/CarPlay is out of scope, so (b)'s cross-platform value doesn't apply.

---

## 4. Data path decision

Requirement: works with the phone UI backgrounded or the JS runtime never started.

**Chosen: a car-session-scoped native store (`DroneTracker`) fed by two sources:**

1. **Backend live feed (primary).** Native OkHttp WebSocket to `/ws?token=<JWT>`,
   `SUBSCRIBE_ORG` (all detections the user's orgs can see, the same scope as the
   phone's passive Live Map and the Wear app), ack-gated subscribe retry, 30 s `PING`,
   backoff reconnect, `SCOPE_CHANGED` → reconnect. Plus a REST hydrate,
   `GET /api/detections/recent?minutes=1`, on each connect. This covers every node
   in the org, not just ones near the phone, and gives nicknames and AGL. Read-only.
2. **Local BLE tap (secondary).** One added call in `BLEScannerService.maybeEnqueueForUpload`
   after `enqueue()` hands the same record to `LocalDetectionTap`. That's a no-op
   (one volatile read) when no car session is running. This shows node-relayed drones
   with no backend round trip, and still works without cellular data.
   It only produces data while the phone app's BLE scanning service is running.

**Auth without JS:** the JWT is read **natively and read-only** from expo-secure-store's
storage (format above), falling back to `UploadConfig.authToken`. Signed out or 401 →
"Sign in on your phone" message screen, re-checked every 10 s.

**Location:** the platform `LocationManager` fused provider (API 31+ = our minSdk, so no
new Play Services dependency), 2 s / 5 m updates while the car screen is visible.

**Rejected alternatives**
* Persisting detections from JS to native: needs JS alive, which is the problem.
* Starting the BLE foreground service from the car service: Android 12+ restricts
  background foreground-service starts, it changes existing behavior, and the backend feed
  already covers relayed detections.
* Persisting a second copy of the token from `BLEScannerModule.configure`: doubles where
  the secret lives and changes an existing code path.

---

## 5. Desktop Head Unit availability (this machine)

Not available, and not installable unattended:
* The Android SDK has no `extras/google/auto` (DHU), no `cmdline-tools` (no `sdkmanager`),
  no `system-images`, and no AVDs.
* `adb devices` lists nothing. The DHU needs a **phone** running Android Auto in developer
  mode with the head unit server started, so even an installed DHU couldn't run here.

Fallback: JVM unit tests for all pure logic + a manual DHU/in-car checklist in
`docs/android-auto.md`. No screenshots were produced (`docs/android-auto-screens/` is not
created).

# Expo SDK 53 → 54 + Android API 36 — Applyable Migration Patch

**Status:** review draft — nothing applied. Authored for review before execution.
**Repo:** `C:\dev\WestshoreWatch` · **Branch to create:** `feature/expo-54` off `master`
**Goal:** Expo 53→54 (RN 0.79.6→0.81.5, React 19.0→19.1) + compileSdk/targetSdk 35→36, to meet Google Play's Aug 31 2026 target-API-36 deadline.
**Constraint:** bare / prebuild-with-committed-native. `expo prebuild --clean` is BANNED (wipes committed Android `WearBridgeModule`, `BLEScannerPackage`, `KeepScreenOnPackage` and the notification native config). `ios/` is `.easignore`d and regenerated from config plugins on every EAS build, so iOS native changes apply automatically.

> Two files need real thought: `android/build.gradle` (version bumps + core-force removal) and `MainApplication.kt` (entry-point merge preserving the 3 custom packages). Everything else is a trivial bump, a no-op, or EAS-regenerated.

---

## 1. `package.json` — dependency bump

⚠️ **Do not hand-edit this file.** Run the `expo install` command in the Apply section; it rewrites `package.json` **and** regenerates `package-lock.json` together. The block below is the **expected result to review**, not a patch to paste (a hand-edited `package.json` without a matching regenerated lockfile will drift — and this repo tracks the lockfile, see memory `dashboard_lockfile` policy analog).

### Confirmed target set (exact pins — these are the ones research locked down)
```diff
   "dependencies": {
-    "@rnmapbox/maps": "10.3.1",
+    "@rnmapbox/maps": "10.3.2",
-    "expo": "~53.0.27",
+    "expo": "~54.0.0",
-    "react": "19.0.0",
+    "react": "19.1.0",
-    "react-native": "0.79.6",
+    "react-native": "0.81.5",
-    "react-native-gesture-handler": "~2.24.0",
+    "react-native-gesture-handler": "~2.28.0",
-    "react-native-reanimated": "~3.19.5",
+    "react-native-reanimated": "~4.1.1",
+    "react-native-worklets": "0.5.1",
-    "react-native-screens": "~4.11.1",
+    "react-native-screens": "~4.16.0",
   }
```
- `react-native-worklets` is **new** and **pinned exact (no caret)** — a JS/native version mismatch throws at startup. Let `expo install` set it; never hand-bump.
- `@rnmapbox/maps` pinned exact `10.3.2` to match the existing exact-pin style (current is `10.3.1`). Already New-Arch/Fabric compatible; this is a no-breaking-change patch.

### Install-resolved remainder (target majors — verify from `expo install --fix` output)
These also move for SDK 54 but their exact minors are computed by `expo install` from SDK 54's `bundledNativeModules.json`. **Do not trust the numbers below as final — confirm against the command output.** Best-known targets:

| package | current | SDK 54 target (verify) |
|---|---|---|
| `@expo/vector-icons` | `^14.1.0` | `^15.0.x` |
| `@react-native-async-storage/async-storage` | `2.1.2` | `2.2.0` |
| `@react-native-community/datetimepicker` | `8.4.1` | `~8.4.x` |
| `expo-asset` | `~11.1.7` | `~12.0.x` |
| `expo-dev-client` | `~5.2.4` | `~6.0.x` |
| `expo-device` | `~7.1.4` | `~8.0.x` |
| `expo-file-system` | `~18.1.11` | `~19.0.x` (default API changed; **zero direct usage** in our code, so no code impact) |
| `expo-font` | `~13.3.2` | `~14.0.x` |
| `expo-keep-awake` | `~14.1.4` | `~15.0.x` |
| `expo-location` | `~18.1.6` | `~19.0.x` |
| `expo-notifications` | `~0.31.5` | `~0.32.x` (our usage is already SDK-54-shaped: `shouldShowBanner`/`shouldShowList`, `subscription.remove()`) |
| `expo-secure-store` | `~14.2.4` | `~15.0.x` |
| `expo-status-bar` | `~2.2.3` | `~3.0.9` (confirmed from SDK 54 template) |
| `react-native-safe-area-context` | `5.4.0` | `~5.6.x` |
| `react-native-webview` | `13.13.5` | `~13.15.x` |
| `@types/react` (dev) | `~19.0.0` | `~19.1.x` |
| `typescript` (dev) | `^5.3.0` | `~5.9.2` (already satisfied by installed 5.9.3) |

Not Expo-managed, leave as-is: `@react-navigation/*`, `zustand`, `patch-package`, `@babel/core`.

**Note on `patch-package`:** no `patches/` directory exists — the `postinstall` hook is a no-op. Nothing to rebase. (Optional cleanup: drop the dead hook.)

---

## 2. `babel.config.js` — remove the manual reanimated plugin

In SDK 54, `babel-preset-expo` bundles the worklets plugin automatically; the old `react-native-reanimated/plugin` path errors under reanimated v4. Remove it.

```diff
 module.exports = function (api) {
   api.cache(true);
   return {
     presets: ['babel-preset-expo'],
-    plugins: ['react-native-reanimated/plugin'],
   };
 };
```
⚠️ Apply this **in the same commit as the SDK 54 install**, never before — removing it on SDK 53 breaks reanimated 3.

---

## 3. `android/build.gradle` — ext bumps + remove androidx.core force

Our root build.gradle is older scaffolding that **hardcodes** versions in `ext {}` (it does not read RN's `libs.versions.toml`), so the bumps are explicit here.

```diff
     ext {
-        buildToolsVersion = findProperty('android.buildToolsVersion') ?: '35.0.0'
+        buildToolsVersion = findProperty('android.buildToolsVersion') ?: '36.0.0'
         minSdkVersion = Integer.parseInt(findProperty('android.minSdkVersion') ?: '31')
-        compileSdkVersion = Integer.parseInt(findProperty('android.compileSdkVersion') ?: '35')
+        compileSdkVersion = Integer.parseInt(findProperty('android.compileSdkVersion') ?: '36')
-        targetSdkVersion = Integer.parseInt(findProperty('android.targetSdkVersion') ?: '35')
+        targetSdkVersion = Integer.parseInt(findProperty('android.targetSdkVersion') ?: '36')
-        kotlinVersion = findProperty('android.kotlinVersion') ?: '1.9.25'
+        kotlinVersion = findProperty('android.kotlinVersion') ?: '2.1.20'

         // NDK r28 — 16 KB page alignment (Play requirement). KEEP — do NOT drop to
         // RN 0.81's default 27.1; 28 is newer and required for our compliance.
         ndkVersion = "28.0.13004108"
     }
```
- **`minSdkVersion` stays 31** (ours; RN 0.81 template default is 24 — do not lower).
- **`ndkVersion` stays `28.0.13004108`** — explicitly kept; RN 0.81's default 27.1 is older.

Remove the androidx.core version force (in the `allprojects { configurations.all { resolutionStrategy { … } } }` block):
```diff
     configurations.all {
         resolutionStrategy {
-            force 'androidx.core:core:1.12.0'
-            force 'androidx.core:core-ktx:1.12.0'
         }
     }
```
**Why remove, not pin:** under compileSdk 36 the force stops being a safeguard and becomes a hazard — it silently downgrades `androidx.core` below what API-36 libs (which request ~1.16–1.17) expect, risking runtime `NoSuchMethodError`. Removing it lets Gradle resolve to the highest requested version. **Determination:** removal is correct; a pin is **not** needed. **Fallback:** *if* a post-removal build surfaces a duplicate-class or version-skew error, pin to **`1.17.0`** (matches the graph's true max; requires compileSdk 36, which we now have) — **not** 1.16.0 (would downgrade libs wanting 1.17.0). If the `resolutionStrategy`/`configurations.all` block is now empty, it can be left empty or deleted.

**Do NOT change:** the `classpath('com.google.gms:google-services:4.4.0')`, the RN-from-npm maven repo block, or the `@rnmapbox/maps-v2-maven` generated block. AGP and the Kotlin plugin classpaths are unversioned and resolve via RN's catalog, so bumping `react-native` to 0.81.5 should pull **AGP 8.11.0** automatically — **verify** (see Apply step 6).

---

## 4. `android/app/build.gradle` — NO CHANGES NEEDED

Confirmed: **no edits required.** SDK versions here come via `rootProject.ext.*` (bumped in §3), so they update automatically. All customizations are untouched by the RN 0.79→0.81 delta:
- `apply plugin: "com.google.gms.google-services"` (FCM) — keep.
- `@rnmapbox/maps-libcpp` `packagingOptions` block — keep.
- `implementation("com.google.android.gms:play-services-wearable:18.2.0")` (WearBridge) — keep.
- `versionCode 26` / `versionName "1.1.5"` — unchanged (bump only when you decide to ship).

The SDK 54 template's cosmetic changes here (`enableProguardInReleaseBuilds`→`enableMinifyInReleaseBuilds` rename, release-block local-var refactor) are **optional and skipped**. The template's new `buildConfigField REACT_NATIVE_RELEASE_LEVEL` is **deliberately NOT added** — the minimal `MainApplication.kt` merge in §6 omits the paired `releaseLevel` wiring, so it isn't required. (Only add both together if you later want RN's release-level feature.)

---

## 5. `gradle/wrapper/gradle-wrapper.properties` — Gradle 8.10.2 → 8.14.3

```diff
-distributionUrl=https\://services.gradle.org/distributions/gradle-8.10.2-all.zip
+distributionUrl=https\://services.gradle.org/distributions/gradle-8.14.3-all.zip
```
(`-all` retained; only the version changes. Gradle re-downloads the distribution on next invocation — no other wrapper files need editing.)

---

## 6. `MainApplication.kt` — merged entry point (preserves 3 custom packages)

Full file. Adopts RN 0.81's `loadReactNative(this)` entry point (replaces `SoLoader.init` + `DefaultNewArchitectureEntryPoint.load()`), drops the removed `isHermesEnabled` override, and **preserves `BLEScannerPackage`, `KeepScreenOnPackage`, `WearBridgePackage`**. Omits the optional `REACT_NATIVE_RELEASE_LEVEL` wiring (so no app/build.gradle change — see §4).

```kotlin
package com.westshoredrone.watch

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.defaults.DefaultReactNativeHost

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost = ReactNativeHostWrapper(
        this,
        object : DefaultReactNativeHost(this) {
          override fun getPackages(): List<ReactPackage> {
            val packages = PackageList(this).packages
            packages.add(BLEScannerPackage())
            packages.add(KeepScreenOnPackage())
            packages.add(WearBridgePackage())
            return packages
          }

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
      }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
```

Diff vs current:
```diff
-import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
+import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
 import com.facebook.react.defaults.DefaultReactNativeHost
-import com.facebook.react.soloader.OpenSourceMergedSoMapping
-import com.facebook.soloader.SoLoader
@@
           override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
-          override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
       }
@@
   override fun onCreate() {
     super.onCreate()
-    SoLoader.init(this, OpenSourceMergedSoMapping)
-    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
-      load()
-    }
+    loadReactNative(this)
     ApplicationLifecycleDispatcher.onApplicationCreate(this)
   }
```
`MainActivity.kt` needs **no change** (stock, identical between SDK 53 and 54).

---

## 7. `gradle.properties` — add edge-to-edge flag

Android 16 (target 36) is always edge-to-edge; add the flag RN 0.81 reads.
```diff
 hermesEnabled=true
+
+# Android 16 edge-to-edge (mandatory at targetSdk 36). Controls behavior on
+# older Android versions; on Android 16 there is no opt-out.
+edgeToEdgeEnabled=true
```
Keep `reactNativeArchitectures=arm64-v8a` (intentional single-arch), `newArchEnabled=true`, `hermesEnabled=true`.

---

## How to apply and verify

### Apply (in order, one branch `feature/expo-54`)
1. `git checkout master && git pull && git checkout -b feature/expo-54`
2. **Deps:** `npx expo install expo@^54` then `npx expo install --fix` (this rewrites `package.json` + regenerates `package-lock.json`; confirm the §1 confirmed-set pins landed and `react-native-worklets@0.5.1` was added). Commit `package.json` + `package-lock.json` **together**.
3. **babel:** apply §2. (Same commit as step 2.)
4. **Android gradle:** apply §3 (`android/build.gradle`), §5 (wrapper), §7 (`gradle.properties`).
5. **Kotlin:** apply §6 (`MainApplication.kt`).
6. Confirm §4: `android/app/build.gradle` unchanged.

### Verify (each is a real gate — do not skip)
1. **Wrapper/AGP resolve:** `cd android && JAVA_HOME="<Android Studio>/jbr" ./gradlew --version` (expect Gradle 8.14.3); `./gradlew :app:dependencies --configuration releaseRuntimeClasspath | grep androidx.core` to confirm core resolved to ~1.16/1.17 (not 1.12) and no skew; `./gradlew buildEnvironment | grep -i "android gradle"` to confirm **AGP 8.11.0**.
2. **expo-doctor:** `npx expo-doctor` — expect the version-mismatch checks to clear (reanimated/gesture-handler/screens/worklets now aligned to SDK 54).
3. **Android release build:** set `JAVA_HOME` to the Android Studio JBR (JDK 21), then `cd android && ./gradlew :app:assembleRelease`. Watch for: AAR-metadata errors (core force fallout — if seen, pin core to 1.17.0 per §3), Kotlin 2.1.20 compile errors, and that `lintVitalRelease`-equivalent passes. Confirm a signed-or-unsigned APK is produced.
4. **EAS iOS build:** `eas build --platform ios --profile preview` — this is the **only** way to exercise the regenerated SDK 54 Podfile + `withBleScanner` + `withFmtConstevalFix`. Watch specifically for: the BLE Swift module finding React headers under SDK 54's default **prebuilt RNCore** (if headers are missing, set `ios.buildReactNativeFromSource: true` in Podfile.properties.json via app.config.js and rebuild); and that `withFmtConstevalFix`'s `post_install do |installer|` anchor still matches (it does in the SDK 54 template).
5. **Device smoke test** (install the built artifacts on real hardware):
   - [ ] **Map screens** — `LiveMapScreen` and `GuestScanScreen` render tiles, camera, shapes/layers, annotations (Mapbox 10.3.2 on Fabric).
   - [ ] **Push notifications** — remote FCM alert arrives, taps deep-link correctly.
   - [ ] **Local notifications** — drone-detection local notification fires (`droneNotifier`), channels created.
   - [ ] **BLE relay** — node detection received over BLE and relayed to backend (Android `BLEScannerService` + iOS BLE module).
   - [ ] **WearBridge handoff** — phone→watch enrollment handshake works (`WearBridgePackage` / `play-services-wearable`); this is the whole reason `prebuild --clean` is banned, so verify explicitly.
   - [ ] **Edge-to-edge** — check no content is clipped under status/nav bars on Android 16 (mandatory edge-to-edge); verify `react-native-safe-area-context` insets.

### Rollback / bisect
Single branch, staged commits (deps+babel / android-gradle / kotlin). If the build breaks, `git bisect` within the branch isolates which stage. Do **not** merge to `master` until steps 1–5 all pass — no intermediate state is production-shippable.

### Fallback if the deadline gets tight
Compliance does **not** strictly require Expo 54. If §4/EAS hit trouble near Aug 31, a minimal `compileSdk`/`targetSdk` 36 + AGP bump on the **current SDK 53 stack** (as done for the Wear app) ships compliance fast; do Expo 54 separately after. Less clean (fights RN 0.79's pinned toolchain); full Expo 54 remains the primary recommendation given ~6 weeks of runway.

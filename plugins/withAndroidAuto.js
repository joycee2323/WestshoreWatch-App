/**
 * Expo config plugin: Android Auto (Car App Library, POI category) for the
 * phone app. Android only; a no-op for iOS.
 *
 * WHY A PLUGIN: android/ is committed and edited by hand today, but a future
 * `expo prebuild --clean` would regenerate it. The car code therefore lives
 * OUTSIDE android/, in plugins/android/AndroidAuto/ (Kotlin sources, the
 * automotive_app_desc.xml resource, and JVM unit tests), and this plugin wires
 * it in. The committed android/ carries the identical edits (applied by hand),
 * so builds work without running prebuild.
 *
 * What it does:
 *   1. app/build.gradle: adds a generated block (between @generated markers)
 *      that adds the plugin source/res/test dirs to the app module's
 *      sourceSets and the androidx.car.app dependencies.
 *   2. AndroidManifest.xml:
 *      - <uses-permission androidx.car.app.MAP_TEMPLATES/> (PlaceListMapTemplate)
 *      - <meta-data com.google.android.gms.car.application → @xml/automotive_app_desc>
 *      - <meta-data androidx.car.app.minCarApiLevel = 5>
 *      - the exported CarAppService with the POI category intent filter
 *
 * IDEMPOTENT: the gradle block is replaced in place by its markers (re-running
 * never duplicates it, and changing the block here updates it). Manifest
 * entries are matched by android:name and added only when missing.
 *
 * iOS FINGERPRINT: fingerprint.config.js excludes this file and this plugin's
 * entry in the expo config from the iOS fingerprint, so adding Android Auto
 * doesn't change the iOS runtime version (OTA updates keep reaching shipped iOS
 * builds). Android uses a literal runtimeVersion and is not fingerprinted.
 */
const { withAndroidManifest, withAppBuildGradle, AndroidConfig } = require('@expo/config-plugins');

const CAR_APP_VERSION = '1.7.0';
const MIN_CAR_API_LEVEL = '5';
const SERVICE_NAME = '.auto.WswCarAppService';
const BEGIN = '// @generated begin withAndroidAuto';
const END = '// @generated end withAndroidAuto';

const GRADLE_BLOCK = `${BEGIN} - Android Auto (Car App Library). Managed by plugins/withAndroidAuto.js; edit there.
// The car code lives outside android/ (plugins/android/AndroidAuto) so that
// \`expo prebuild\` can never wipe it.
android {
    sourceSets {
        main {
            java.srcDirs += ["\${rootDir}/../plugins/android/AndroidAuto/src/main/java"]
            res.srcDirs += ["\${rootDir}/../plugins/android/AndroidAuto/src/main/res"]
        }
        test {
            java.srcDirs += ["\${rootDir}/../plugins/android/AndroidAuto/src/test/java"]
        }
        // Debug-only fake-drone simulator (adb broadcast DEBUG_SIM). Release gets a
        // no-op AutoDebugHooks with the same signature and none of the simulator.
        debug {
            java.srcDirs += ["\${rootDir}/../plugins/android/AndroidAuto/src/debug/java"]
        }
        release {
            java.srcDirs += ["\${rootDir}/../plugins/android/AndroidAuto/src/release/java"]
        }
        testDebug {
            java.srcDirs += ["\${rootDir}/../plugins/android/AndroidAuto/src/testDebug/java"]
        }
    }
    // Robolectric template tests (ScreenTemplatesTest) need merged resources.
    testOptions {
        unitTests {
            includeAndroidResources = true
        }
    }
}
dependencies {
    implementation("androidx.car.app:app:${CAR_APP_VERSION}")
    implementation("androidx.car.app:app-projected:${CAR_APP_VERSION}")
    // Real org.json for JVM unit tests (android.jar only ships stubs).
    testImplementation("org.json:json:20240303")
    // Builds the real templates in JVM tests so the library's validation runs.
    testImplementation("androidx.car.app:app-testing:${CAR_APP_VERSION}")
    testImplementation("org.robolectric:robolectric:4.14.1")
}
${END}`;

/** Inserts or replaces the generated block. Pure, exported for tests. */
function applyGradleBlock(src) {
  const start = src.indexOf(BEGIN);
  if (start !== -1) {
    const endIdx = src.indexOf(END, start);
    if (endIdx === -1) throw new Error('withAndroidAuto: found begin marker without end marker in app/build.gradle');
    const current = src.slice(start, endIdx + END.length);
    if (current === GRADLE_BLOCK) return src;
    return src.slice(0, start) + GRADLE_BLOCK + src.slice(endIdx + END.length);
  }
  return `${src.replace(/\s*$/, '')}\n\n${GRADLE_BLOCK}\n`;
}

/** Adds the car app manifest entries if missing. Pure on the manifest JSON; exported for tests. */
function applyManifest(manifest) {
  const m = manifest.manifest;
  m['uses-permission'] = m['uses-permission'] || [];
  if (!m['uses-permission'].some((p) => p.$['android:name'] === 'androidx.car.app.MAP_TEMPLATES')) {
    m['uses-permission'].push({ $: { 'android:name': 'androidx.car.app.MAP_TEMPLATES' } });
  }

  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  app['meta-data'] = app['meta-data'] || [];
  const upsertMeta = (attrs) => {
    const existing = app['meta-data'].find((md) => md.$['android:name'] === attrs['android:name']);
    if (existing) existing.$ = { ...attrs };
    else app['meta-data'].push({ $: { ...attrs } });
  };
  upsertMeta({
    'android:name': 'com.google.android.gms.car.application',
    'android:resource': '@xml/automotive_app_desc',
  });
  upsertMeta({ 'android:name': 'androidx.car.app.minCarApiLevel', 'android:value': MIN_CAR_API_LEVEL });

  app.service = app.service || [];
  const service = {
    $: {
      'android:name': SERVICE_NAME,
      'android:exported': 'true',
      'android:label': '@string/app_name',
      'android:icon': '@mipmap/ic_launcher',
    },
    'intent-filter': [
      {
        action: [{ $: { 'android:name': 'androidx.car.app.CarAppService' } }],
        category: [{ $: { 'android:name': 'androidx.car.app.category.POI' } }],
      },
    ],
  };
  const idx = app.service.findIndex((s) => s.$['android:name'] === SERVICE_NAME);
  if (idx === -1) app.service.push(service);
  else app.service[idx] = service;
  return manifest;
}

const withAndroidAuto = (config) => {
  config = withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withAndroidAuto: expected a Groovy app/build.gradle');
    }
    cfg.modResults.contents = applyGradleBlock(cfg.modResults.contents);
    return cfg;
  });
  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyManifest(cfg.modResults);
    return cfg;
  });
  return config;
};

module.exports = withAndroidAuto;
module.exports.applyGradleBlock = applyGradleBlock;
module.exports.applyManifest = applyManifest;
module.exports.GRADLE_BLOCK = GRADLE_BLOCK;

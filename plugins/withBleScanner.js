/**
 * Expo config plugin — injects the hand-written iOS BLEScanner native module
 * (Swift + Obj-C bridge) into the prebuilt Xcode project.
 *
 * WHY A PLUGIN: this is an Expo-managed project. `expo prebuild` regenerates the
 * native `ios/` directory from scratch, so any files placed there by hand are
 * wiped on the next prebuild. The source of truth therefore lives in the
 * repo-tracked `plugins/ios/BLEScanner/` directory, and this plugin copies those
 * files into the generated project and registers them with the Xcode target on
 * every prebuild — the standard pattern for hand-authored native code in a
 * managed workflow (mirrors how the Android side ships committed Kotlin under
 * `android/`, which Expo does not regenerate here).
 *
 * What it does, in order:
 *   1. withDangerousMod (ios): copies WSW*.swift, WSWBLEScanner.m and the
 *      bridging header from plugins/ios/BLEScanner into ios/<Project>/.
 *   2. withXcodeProject: adds the Swift/.m sources to the app target's
 *      Sources build phase, and the .h to the project.
 *   3. ensures SWIFT_OBJC_BRIDGING_HEADER is set (or that the existing
 *      Expo-generated bridging header imports the React headers we need).
 *
 * NEEDS VERIFICATION ON FIRST iOS BUILD (cannot be exercised without macOS/EAS):
 *   - pbxproj group/target wiring is correct for this Expo SDK's project layout.
 *   - The bridging-header resolution branch matches what `expo prebuild`
 *     actually emits for this template (Swift-present vs not).
 *   - Under the New Architecture / bridgeless runtime, a legacy
 *     RCT_EXTERN_REMAP_MODULE is reachable via TurboModuleRegistry.get(); if not,
 *     enable the legacy-module interop or migrate to a codegen TurboModule spec.
 */
const {
  withDangerousMod,
  withXcodeProject,
  IOSConfig,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SOURCE_DIR = path.join('plugins', 'ios', 'BLEScanner');
const SWIFT_FILES = [
  'WSWOdidParser.swift',
  'WSWDetectionUploader.swift',
  'WSWNodeHeartbeatUploader.swift',
  'WSWBLEScanner.swift',
];
const OBJC_FILES = ['WSWBLEScanner.m'];
const BRIDGING_HEADER = 'WestshoreWatch-Bridging-Header.h';

function copySources(projectRoot, iosProjectDir) {
  const src = path.join(projectRoot, SOURCE_DIR);
  const all = [...SWIFT_FILES, ...OBJC_FILES, BRIDGING_HEADER];
  for (const f of all) {
    const from = path.join(src, f);
    const to = path.join(iosProjectDir, f);
    fs.copyFileSync(from, to);
  }
}

const withCopySources = (config) =>
  withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const platformProjectRoot = cfg.modRequest.platformProjectRoot; // ios/
      const projectName = cfg.modRequest.projectName; // e.g. "WestshoreWatch"
      const iosProjectDir = path.join(platformProjectRoot, projectName);
      copySources(projectRoot, iosProjectDir);
      return cfg;
    },
  ]);

const withSourcesInXcode = (config) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = cfg.modRequest.projectName;
    const group = projectName; // main app group matches the project name

    for (const f of [...SWIFT_FILES, ...OBJC_FILES]) {
      // addSourceFile is idempotent enough across prebuilds for our purposes;
      // guard so re-runs don't create duplicate build-file refs.
      if (!project.hasFile(`${group}/${f}`)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
          filepath: `${group}/${f}`,
          groupName: group,
          project,
        });
      }
    }

    // Ensure the bridging header build setting points at our header. If Expo
    // already generated one for the template's Swift, this overwrites the path
    // to ours (which carries the React imports the module needs).
    const configurations = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configurations)) {
      const buildSettings = configurations[key].buildSettings;
      if (!buildSettings) continue;
      buildSettings.SWIFT_OBJC_BRIDGING_HEADER = `${group}/${BRIDGING_HEADER}`;
      // Hand-written Swift in a brownfield/managed app needs these defaults if
      // the template didn't already include Swift.
      if (!buildSettings.SWIFT_VERSION) buildSettings.SWIFT_VERSION = '5.0';
      buildSettings.CLANG_ENABLE_MODULES = 'YES';
    }

    return cfg;
  });

module.exports = (config) => withSourcesInXcode(withCopySources(config));

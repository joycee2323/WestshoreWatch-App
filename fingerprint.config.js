// Android-only config plugins: excluded from the fingerprint entirely.
//
// Why this is safe: only iOS uses the 'fingerprint' runtimeVersion policy
// (Android is pinned to a literal runtimeVersion, see app.config.js), and these
// plugins do nothing on iOS. Without this exclusion, adding an Android-only
// plugin changes the iOS fingerprint (the plugin's entry in the expo config AND
// its module file are both hashed), which would stop OTA updates from reaching
// already-shipped iOS builds even though iOS didn't change.
//
// Two parts, both needed:
//   - ignorePaths: drops the plugin MODULE file from the hashed sources
//     (@expo/fingerprint filters the config's loadedModules by ignorePaths).
//   - fileHookTransform: removes the plugin's string entry from the
//     `expoConfig` contents before hashing.
// Verified: the iOS fingerprint is identical with and without the plugin
// (see docs/android-auto-decisions.md).
const ANDROID_ONLY_PLUGINS = ['./plugins/withAndroidAuto'];

function stripAndroidOnlyPlugins(contents) {
  let config;
  try {
    config = JSON.parse(contents);
  } catch {
    return contents;
  }
  if (!Array.isArray(config.plugins)) return contents;
  const plugins = config.plugins.filter(
    (p) => !(typeof p === 'string' && ANDROID_ONLY_PLUGINS.includes(p)),
  );
  if (plugins.length === config.plugins.length) return contents;
  // @expo/fingerprint serializes the config with sorted keys and no
  // whitespace; replacing just the plugins array keeps everything else
  // byte-identical to what it would have hashed without the plugin.
  const before = JSON.stringify(config.plugins);
  const after = JSON.stringify(plugins);
  return contents.includes(before) ? contents.replace(before, after) : contents;
}

module.exports = {
  ignorePaths: [
    // Per-environment Firebase config, not native-runtime-relevant. EAS
    // Build's "Prepare credentials" phase writes the GOOGLE_SERVICES_JSON
    // secret into this exact path before the fingerprint check runs, so its
    // content is expected to differ from whatever's on a local dev machine —
    // that's the intended per-environment substitution (see app.config.js's
    // googleServicesFile comment), not real native drift. Without this
    // exclusion it permanently breaks the "fingerprint" runtimeVersion
    // policy's local-vs-EAS match on every Android build, regardless of git
    // state (confirmed via real build logs — see PR/commit description).
    //
    // NOTE: EAS's same credentials phase also injects a release signingConfig
    // into android/app/build.gradle. That file is NOT excluded here — it
    // also carries real native-runtime-relevant content (NDK version,
    // packagingOptions, the dependencies block incl. WearBridge's
    // play-services-wearable version, gif/webp toggles), and @expo/fingerprint
    // has no mechanism for excluding just a region of a file. Excluding the
    // whole file would blind fingerprinting to genuine future native changes,
    // so it's left in scope — the Android build may still show a residual
    // "Runtime version mismatch" from the signing-config injection alone.
    // That's a separate, unresolved architectural question (EAS-managed
    // remote credentials writing into a committed, non-CNG android/), not
    // something ignorePaths can fix.
    'android/app/google-services.json',
    // Android Auto config plugin module (see header comment).
    'plugins/withAndroidAuto.js',
  ],
  fileHookTransform: (source, chunk, isEndOfFile, encoding) => {
    if (source.type === 'contents' && source.id === 'expoConfig' && chunk != null) {
      return stripAndroidOnlyPlugins(typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8'));
    }
    return chunk;
  },
};

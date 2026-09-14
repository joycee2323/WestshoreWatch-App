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
  ],
};

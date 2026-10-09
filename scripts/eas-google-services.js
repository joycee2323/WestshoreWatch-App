// EAS Build hook (package.json "eas-build-post-install").
//
// The Android project is bare (android/ is committed), so EAS does not run
// prebuild and app.config.js's android.googleServicesFile is never applied:
// the Google Services Gradle plugin reads android/app/google-services.json
// directly. The EAS file variable GOOGLE_SERVICES_JSON is written to a temp
// file on the build machine and the variable holds its path, so copy it into
// place. No-op when the variable is unset — then the build uses whatever file
// was uploaded (local builds / the 1.2.4 fallback of copying it in by hand).
const fs = require('fs');
const path = require('path');

const src = process.env.GOOGLE_SERVICES_JSON;
if (process.env.EAS_BUILD_PLATFORM !== 'android' || !src) {
  process.exit(0);
}
if (!fs.existsSync(src)) {
  console.error(`[eas-google-services] GOOGLE_SERVICES_JSON is set but ${src} does not exist`);
  process.exit(1);
}
const dst = path.join(__dirname, '..', 'android', 'app', 'google-services.json');
fs.copyFileSync(src, dst);
console.log('[eas-google-services] copied GOOGLE_SERVICES_JSON to android/app/google-services.json');

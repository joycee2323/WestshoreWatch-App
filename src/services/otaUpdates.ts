import * as Updates from 'expo-updates';

// expo-updates' native CHECK_ON_LAUNCH=ALWAYS config downloads an available
// update in the background on every launch, but only APPLIES it on the
// NEXT cold launch (confirmed via a real-device adb logcat trace — a
// launch that downloads an update ends with isUpdatePending=true, not
// applied). Android's recent-apps swipe often doesn't fully kill the
// process (especially on some OEM skins), so a genuine second cold launch
// — the thing that actually promotes a pending update to running — may
// never happen for most real-world users. This does the full
// check -> fetch -> reload cycle explicitly in JS, within the SAME
// launch, so a single app open (even from recents) picks up the latest
// published update. The native CHECK_ON_LAUNCH setting is left as-is: a
// harmless, independent safety net that keeps working even if this JS
// path has a bug or never runs (e.g. a crash before this executes).
//
// Bounded and fully non-fatal by design — this runs before the app's UI
// renders (see App.tsx), so it must never hang or crash startup:
// - Every failure (offline, server error, disabled in dev/Expo Go) is
//   caught and logged; falls through to normal boot on the
//   already-embedded/previously-applied bundle.
// - Each network step is capped by its own timeout. withTimeout only
//   stops WAITING on the underlying call — expo-updates has no
//   cancellation API, so a timed-out check/fetch keeps running natively
//   in the background regardless, same as the native CHECK_ON_LAUNCH
//   path would anyway. A timeout just means this launch falls back to
//   the two-launch behavior instead of blocking the splash.
const CHECK_TIMEOUT_MS = 2000;
const FETCH_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Checks for, downloads, and applies an OTA update at startup, all within
// this launch. Call once, at app mount — see App.tsx. Never throws.
export async function checkAndApplyUpdateAsync(): Promise<void> {
  if (!Updates.isEnabled) return; // dev mode / Expo Go / disabled config

  try {
    const checkResult = await withTimeout(Updates.checkForUpdateAsync(), CHECK_TIMEOUT_MS, 'update check');
    if (!checkResult.isAvailable) return;

    const fetchResult = await withTimeout(Updates.fetchUpdateAsync(), FETCH_TIMEOUT_MS, 'update fetch');
    // isNew is false if we're already running this exact update (shouldn't
    // happen given isAvailable was true, but expo-updates already does
    // this comparison for us) or if it resolved to a roll-back-to-embedded
    // directive, which doesn't make sense to "reload" into.
    if (!fetchResult.isNew) return;

    // Per expo-updates' own docs: no meaningful logic should run after
    // this resolves — the JS runtime may already be mid-teardown by the
    // time the promise settles, so this function's job is done either way.
    await Updates.reloadAsync();
  } catch (err) {
    console.warn('[ota] startup update check/apply failed (non-fatal, booting normally):', err);
  }
}

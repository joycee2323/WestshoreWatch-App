import * as Updates from 'expo-updates';
import { AppState, AppStateStatus } from 'react-native';

// expo-updates' native CHECK_ON_LAUNCH=ALWAYS config downloads an available
// update in the background on every launch, but only APPLIES it on the
// NEXT cold launch (confirmed via a real-device adb logcat trace — a
// launch that downloads an update ends with isUpdatePending=true, not
// applied). Android's recent-apps swipe (and even a plain home-button
// background/resume — also confirmed live: the process PID never changed
// across a full background/foreground cycle) often doesn't kill the
// process at all, so the thing that actually promotes a pending update to
// running may never happen for most real-world users.
//
// Two triggers, two different levels of aggressiveness, deliberately:
// - checkAndApplyUpdateAsync (mount / cold launch): check, fetch, AND
//   reload immediately if new. Safe because this runs before any UI has
//   rendered (see App.tsx) — a reload here is invisible, never visible as
//   a disruption.
// - startResumeUpdateChecks (foreground resume): check and fetch (STAGE)
//   only — never reloads. The app has no navigation-state persistence
//   (confirmed this session), so a reload mid-task would silently discard
//   whatever screen/detail-view the officer is in. Staging on every
//   resume still meaningfully closes the reliability gap: whatever gets
//   staged here is picked up at zero risk the next time this device does
//   cold-launch, which happens regularly in practice (OS memory reclaim,
//   restarts, incidental force-closes) even if rarely at the user's
//   choosing. Deliberately does NOT scale reload aggressiveness by idle
//   duration (e.g. "reload if backgrounded > 30 min") — any such
//   threshold is a guess that can still catch someone mid-task (a long
//   call, a long wait on scene), and the whole value of this split is
//   that it requires no guessing at all.
//
// The native CHECK_ON_LAUNCH setting is left as-is: a harmless,
// independent safety net that keeps working even if this JS path has a
// bug or never runs (e.g. a crash before this executes).
//
// Bounded and fully non-fatal by design in both paths:
// - Every failure (offline, server error, disabled in dev/Expo Go) is
//   caught and logged; falls through to normal operation.
// - Each network step is capped by its own timeout. withTimeout only
//   stops WAITING on the underlying call — expo-updates has no
//   cancellation API, so a timed-out check/fetch keeps running natively
//   in the background regardless, same as the native CHECK_ON_LAUNCH
//   path would anyway.
const CHECK_TIMEOUT_MS = 2000;
const FETCH_TIMEOUT_MS = 5000;

// Resume-path debounce only — a genuine cold launch always checks
// unconditionally regardless of this. 10 minutes: frequent enough to
// catch a fresh publish soon after a genuine pause, infrequent enough to
// not spam checks (network/battery cost, and expo-updates' own docs warn
// update checks may be server-rate-limited) on rapid app-switching.
const RESUME_DEBOUNCE_MS = 10 * 60 * 1000;
let lastCheckedAt = 0;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Checks for and downloads (but does not apply) an available update.
// Shared by both the mount and resume paths below. Never throws; always
// stamps lastCheckedAt so the resume-path debounce sees this attempt
// regardless of outcome.
async function checkAndFetchUpdateAsync(): Promise<boolean> {
  if (!Updates.isEnabled) return false; // dev mode / Expo Go / disabled config

  try {
    console.log('[ota] check started');
    const checkResult = await withTimeout(Updates.checkForUpdateAsync(), CHECK_TIMEOUT_MS, 'update check');
    if (!checkResult.isAvailable) {
      console.log('[ota] no update available');
      return false;
    }
    console.log('[ota] update available, id=', checkResult.manifest.id);

    const fetchResult = await withTimeout(Updates.fetchUpdateAsync(), FETCH_TIMEOUT_MS, 'update fetch');
    // isNew is false if we're already running this exact update (shouldn't
    // happen given isAvailable was true, but expo-updates already does
    // this comparison for us) or if it resolved to a roll-back-to-embedded
    // directive, which doesn't make sense to apply.
    if (!fetchResult.isNew) {
      console.log('[ota] fetch resolved to a non-new update, skipping');
      return false;
    }
    console.log('[ota] fetch succeeded, id=', fetchResult.manifest.id);
    return true;
  } catch (err) {
    console.warn('[ota] check/fetch failed (non-fatal):', err);
    return false;
  } finally {
    lastCheckedAt = Date.now();
  }
}

// Cold-launch path: check, fetch, and reload immediately if a new update
// was staged. Call once, at app mount — see App.tsx. Never throws.
export async function checkAndApplyUpdateAsync(): Promise<void> {
  const fetched = await checkAndFetchUpdateAsync();
  if (!fetched) return;

  try {
    console.log('[ota] reloading now');
    // Per expo-updates' own docs: no meaningful logic should run after
    // this resolves — the JS runtime may already be mid-teardown by the
    // time the promise settles, so this function's job is done either way.
    await Updates.reloadAsync();
  } catch (err) {
    console.warn('[ota] reload failed (non-fatal):', err);
  }
}

// Resume path: re-checks and stages (never applies) an update whenever
// the app has a genuine background/inactive -> active transition. Call
// once, at app mount, and use the returned cleanup in the same effect —
// see App.tsx. Mirrors the transition-tracking pattern already used for
// this exact purpose in LiveMapScreen.tsx (prevState comparison, not just
// "current state is active", since 'change' fires on other transitions
// too and would otherwise re-fire spuriously).
export function startResumeUpdateChecks(): () => void {
  let prevState = AppState.currentState;
  const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
    const cameToForeground = prevState !== 'active' && state === 'active';
    prevState = state;
    if (!cameToForeground) return;
    if (Date.now() - lastCheckedAt < RESUME_DEBOUNCE_MS) return;
    void checkAndFetchUpdateAsync();
  });
  return () => sub.remove();
}

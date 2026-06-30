import { useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import { isBleScanning } from '../services/bleScanner';
import {
  hasNotificationPermission,
  scheduleScanWarning,
  cancelScanWarning,
} from '../services/scanBackgroundNotifier';

// iOS-only safeguard: when the app is backgrounded (or goes inactive) while a
// BLE scan is actively running, warn the user that iOS is throttling
// detection. Prefers an OS local notification — scheduled with a short delay
// and cancelled if the user returns quickly, so brief app-switches don't fire
// it. When notification permission is denied, it falls back to an in-app
// banner shown on return to the foreground.
//
// "Scan is active" is tied to the real scanner state (isBleScanning), NOT to
// whether the screen is mounted: a mounted-but-idle screen never warns.
//
// Returns banner state for the permission-denied fallback; render a banner
// with `showBanner` and call `dismissBanner` to clear it.
export function useScanActiveWarning(): { showBanner: boolean; dismissBanner: () => void } {
  const [showBanner, setShowBanner] = useState(false);
  // Id of the pending scheduled notification, so we can cancel it on return.
  const pendingIdRef = useRef<string | null>(null);
  // Whether the app is currently in the foreground. Used to settle the race
  // where the user returns before scheduleScanWarning() resolves: the async
  // schedule checks this on completion and self-cancels if we're already back.
  const isForegroundRef = useRef(AppState.currentState === 'active');
  // Set when we backgrounded-during-scan without notification permission, so
  // we know to raise the banner once the app returns to the foreground.
  const bannerOnReturnRef = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    let prevState = AppState.currentState;
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      const leavingForeground = prevState === 'active' && state !== 'active';
      const enteringForeground = prevState !== 'active' && state === 'active';
      isForegroundRef.current = state === 'active';

      if (leavingForeground && isBleScanning()) {
        // Background/inactive while scanning — warn the user. Schedule an OS
        // notification if we can, otherwise remember to show the banner on
        // return.
        void (async () => {
          if (await hasNotificationPermission()) {
            const id = await scheduleScanWarning();
            // If the user returned to the foreground while the schedule was
            // resolving, the enter-foreground handler saw a still-null ref and
            // cancelled nothing — so cancel here instead. Otherwise track the
            // id for the normal cancel-on-return path.
            if (isForegroundRef.current) {
              void cancelScanWarning(id);
            } else {
              pendingIdRef.current = id;
            }
          } else {
            bannerOnReturnRef.current = true;
          }
        })();
      } else if (enteringForeground) {
        // Returned to the foreground — cancel the pending notification so a
        // brief app-switch doesn't fire it.
        const id = pendingIdRef.current;
        pendingIdRef.current = null;
        void cancelScanWarning(id);
        // Permission-denied fallback: surface the in-app banner now.
        if (bannerOnReturnRef.current) {
          bannerOnReturnRef.current = false;
          setShowBanner(true);
        }
      }

      prevState = state;
    });

    return () => {
      sub.remove();
      // Don't leave a scheduled warning dangling if the screen unmounts while
      // backgrounded.
      void cancelScanWarning(pendingIdRef.current);
      pendingIdRef.current = null;
    };
  }, []);

  return { showBanner, dismissBanner: () => setShowBanner(false) };
}

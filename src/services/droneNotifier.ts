// Local drone-detection notification fallback.
//
// Before Phase B push notifications were wired, this module fired a
// local notification on first BLE sighting of every drone. Now that
// the backend dispatches an 'drone_detected' push (with
// data.uas_id set) on first server-side detection, firing the local
// one immediately would cause duplicates. Instead, this module starts
// an 8-second pending timer per uasId; a backend push arriving on the
// same uasId cancels the timer. If 8 seconds elapse without a push,
// the local notification fires as a fallback (e.g. backend down,
// network unreachable, push system broken).
//
// Why uasId-only (not [deploymentId, uasId])?
//   The BLE scanner's call site (bleScanner.ts) only has uasId in
//   scope, not the active deployment. In practice the user is only
//   ever in one active deployment per app session, and the
//   notification content is identical regardless of deployment, so
//   uasId alone is sufficient for correctness. If the app ever
//   supports multiple concurrent deployments per session, the timer
//   key should be widened.
//
// Why 8 seconds?
//   Coalescer 1500ms + Expo P99 ~5s + LTE round-trip ≤2s ≈ 8s. Enough
//   margin without making the fallback feel laggy when the backend is
//   genuinely down. If users report missed alerts during transient
//   network blips, raise this; if they report the backend push and
//   fallback both firing too often, lower it.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const FALLBACK_TIMEOUT_MS = 8000;

// UAS IDs already notified this session — don't repeat.
const notifiedUasIds = new Set<string>();

// uasId → timer handle for pending-fallback notifications. Cleared
// when a matching push arrives, when the fallback fires, or when
// reset() is called (logout, BLE stop, etc.).
const pendingFallbacks = new Map<string, ReturnType<typeof setTimeout>>();

let permissionStatus: 'unknown' | 'granted' | 'denied' = 'unknown';
let initPromise: Promise<void> | null = null;
let crossRefSub: { remove(): void } | null = null;

export function initDroneNotifications(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowAlert: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });

      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('drone-detections', {
          name: 'Drone Detections',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
        });
      }

      const existing = await Notifications.getPermissionsAsync();
      let status = existing.status;
      if (status !== 'granted') {
        const req = await Notifications.requestPermissionsAsync();
        status = req.status;
      }
      permissionStatus = status === 'granted' ? 'granted' : 'denied';

      // Cross-reference incoming pushes against pending fallback
      // timers. A backend 'drone_detected' push with matching uas_id
      // cancels the timer so we don't double-notify. The listener
      // also fires on non-drone pushes; we ignore them via the kind
      // check.
      try {
        crossRefSub = Notifications.addNotificationReceivedListener(notification => {
          try {
            const data = notification?.request?.content?.data || {};
            if (data.kind !== 'drone_detected') return;
            const pushUasId = typeof data.uas_id === 'string' ? data.uas_id : null;
            if (!pushUasId) return;
            const timer = pendingFallbacks.get(pushUasId);
            if (timer) {
              clearTimeout(timer);
              pendingFallbacks.delete(pushUasId);
            }
          } catch {}
        });
      } catch (err) {
        console.warn('[droneNotifier] cross-ref listener failed to attach:', err);
      }

      console.log(`droneNotifier: now operating as local fallback (timeout ${FALLBACK_TIMEOUT_MS}ms)`);
    } catch (e) {
      console.warn('[droneNotifier] init failed:', e);
      permissionStatus = 'denied';
    }
  })();
  return initPromise;
}

async function fireFallbackNotification(uasId: string): Promise<void> {
  if (permissionStatus !== 'granted') return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'New Drone Detected',
        body: `UAS ID: ${uasId}`,
        sound: 'default',
        data: { source: 'local_fallback', uas_id: uasId },
      },
      trigger: Platform.OS === 'android'
        ? { channelId: 'drone-detections' } as any
        : null,
    });
  } catch (e) {
    console.warn('[droneNotifier] schedule failed:', e);
  }
}

export async function notifyNewDrone(uasId: string): Promise<void> {
  if (!uasId) return;
  if (notifiedUasIds.has(uasId)) return;
  notifiedUasIds.add(uasId);

  // Don't even start a timer if permission denied — saves the
  // 8-second wait and the eventual no-op fire.
  if (permissionStatus !== 'granted') return;

  // Already pending? Coalesce — keep the existing timer.
  if (pendingFallbacks.has(uasId)) return;

  const timer = setTimeout(() => {
    pendingFallbacks.delete(uasId);
    void fireFallbackNotification(uasId);
  }, FALLBACK_TIMEOUT_MS);
  pendingFallbacks.set(uasId, timer);
}

// Clear pending timers and the seen-set. Call on logout, BLE scan
// stop, or any other "session reset" event.
export function resetNotifiedDrones(): void {
  notifiedUasIds.clear();
  for (const timer of pendingFallbacks.values()) {
    clearTimeout(timer);
  }
  pendingFallbacks.clear();
}

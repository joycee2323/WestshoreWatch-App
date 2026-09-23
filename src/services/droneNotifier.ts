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
//
// Stale-frame guards (incident 2026-09-22: an M1 kept radiating one cached
// Pack with a frozen ODID timestamp for 30+ minutes. The backend rejected
// every upload as stale, so no backend push ever cancelled the timer and this
// fallback fired "New Drone Detected" for a drone that wasn't there — again
// after every restart and after clear-data):
//   1. ODID-age gate. The frame's timestamp is deciseconds since the UTC
//      hour, stamped by the drone's GPS clock; the phone clock is NTP-synced,
//      so a frame older than the backend's limit never arms the fallback.
//      This is what covers clear-data: persisted state is wiped with it, but
//      a ghost frame is still old.
//   2. Backend verdict. The upload paths report per-drone accepted/rejected
//      results (DetectionUploadResult event from the native uploaders; a
//      direct call from the node-less JS uploader). A rejected (stale) frame
//      cancels the pending fallback unless the backend already accepted this
//      drone. Needs the backend's `accepted`/`rejected` response fields;
//      against an older backend this layer is inert and 1 + 3 still apply.
//   3. Persisted dedup (AsyncStorage): the same (uasId, ts) never re-alerts,
//      and a uasId doesn't re-alert within NOTIFY_COOLDOWN_MS, across app
//      restarts.

import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter, Platform } from 'react-native';

const FALLBACK_TIMEOUT_MS = 8000;

// Mirror the backend gate (WestshoreWatch-Backend services/odidStaleGate.js).
const ODID_RING_DS = 36000;
const MAX_ODID_AGE_DS = 3000;     // 5 min in the past
const MAX_ODID_FUTURE_DS = 600;   // 60 s ahead (drone clock skew)

const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
const PERSIST_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_PERSISTED = 500;
const STORAGE_KEY = 'wsw.droneNotifier.v1';

// uasId → when a local notification was last armed (wall-clock ms) and the
// ODID ts that armed it. Persisted.
const notified = new Map<string, { at: number; ts: number | null }>();

// `${uasId}:${ts}` → wall-clock ms the backend rejected that exact frame.
// Persisted, so a ghost frame never re-arms after a restart.
const rejectedFrames = new Map<string, number>();

// uasId → timer handle for pending-fallback notifications. Cleared
// when a matching push arrives, when the backend rejects the arming
// frame, when the fallback fires, or when reset() is called.
const pendingFallbacks = new Map<string, ReturnType<typeof setTimeout>>();
// uasId → ODID ts that armed the pending fallback.
const pendingTs = new Map<string, number | null>();
// uasIds the backend accepted while their fallback was pending: a later
// rejection (e.g. a duplicate of the same frame) must not cancel those.
const acceptedWhilePending = new Set<string>();

let permissionStatus: 'unknown' | 'granted' | 'denied' = 'unknown';
let initPromise: Promise<void> | null = null;
let crossRefSub: { remove(): void } | null = null;
let uploadResultSub: { remove(): void } | null = null;
let loadPromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

// ── ODID age ────────────────────────────────────────────────────────────────

function validTs(ts: unknown): number | null {
  if (typeof ts !== 'number' || !Number.isInteger(ts) || ts < 0 || ts > ODID_RING_DS) return null;
  return ts === ODID_RING_DS ? 0 : ts;
}

// Signed age in deciseconds (negative = in the future), folded to ±half-hour.
export function odidAgeDs(ts: number, nowMs: number = Date.now()): number {
  const dsIntoHour = Math.floor((((nowMs % 3600000) + 3600000) % 3600000) / 100);
  const raw = (((dsIntoHour - ts) % ODID_RING_DS) + ODID_RING_DS) % ODID_RING_DS;
  return raw > ODID_RING_DS / 2 ? raw - ODID_RING_DS : raw;
}

// Null/invalid ts (legacy frames) can't be judged — treated as fresh.
export function isOdidFresh(ts: number | null | undefined, nowMs: number = Date.now()): boolean {
  const v = validTs(ts);
  if (v === null) return true;
  const age = odidAgeDs(v, nowMs);
  return age <= MAX_ODID_AGE_DS && age >= -MAX_ODID_FUTURE_DS;
}

// ── Persistence ─────────────────────────────────────────────────────────────

function ensureLoaded(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const now = Date.now();
      for (const [uasId, v] of Object.entries<any>(parsed?.notified || {})) {
        if (v && typeof v.at === 'number' && now - v.at < PERSIST_RETENTION_MS && !notified.has(uasId)) {
          notified.set(uasId, { at: v.at, ts: validTs(v.ts) });
        }
      }
      for (const [key, at] of Object.entries<any>(parsed?.rejected || {})) {
        if (typeof at === 'number' && now - at < PERSIST_RETENTION_MS && !rejectedFrames.has(key)) {
          rejectedFrames.set(key, at);
        }
      }
    } catch (e) {
      console.warn('[droneNotifier] load failed:', e);
    }
  })();
  return loadPromise;
}

// Newest MAX_PERSISTED entries of a map, by the given timestamp.
function newest<V>(m: Map<string, V>, atOf: (v: V) => number): Array<[string, V]> {
  return Array.from(m.entries()).sort((a, b) => atOf(b[1]) - atOf(a[1])).slice(0, MAX_PERSISTED);
}

// Debounced write — many frames can land in the same second.
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const body = JSON.stringify({
      notified: Object.fromEntries(newest(notified, v => v.at)),
      rejected: Object.fromEntries(newest(rejectedFrames, v => v)),
    });
    AsyncStorage.setItem(STORAGE_KEY, body).catch(e => console.warn('[droneNotifier] persist failed:', e));
  }, 1000);
}

// ── Backend verdicts ────────────────────────────────────────────────────────

export interface UploadRejection {
  id?: string;
  uas_id?: string;
  ts?: number | null;
  reason?: string;
}

// Apply one POST's per-drone results. `accepted` are uasIds the backend stored
// as fresh; `rejected` are frames it classified stale (too_old / unchanged /
// out_of_order / frozen). Called by detectionUpload.ts directly and via the
// DetectionUploadResult event from the native uploaders.
export function applyUploadResult(accepted: string[] = [], rejected: UploadRejection[] = []): void {
  for (const uasId of accepted) {
    if (pendingFallbacks.has(uasId)) acceptedWhilePending.add(uasId);
  }
  let changed = false;
  for (const r of rejected) {
    const uasId = r?.id ?? r?.uas_id;
    if (!uasId) continue;
    const ts = validTs(r.ts);
    if (ts !== null) {
      rejectedFrames.set(`${uasId}:${ts}`, Date.now());
      changed = true;
    }
    const timer = pendingFallbacks.get(uasId);
    if (!timer || acceptedWhilePending.has(uasId)) continue;
    // Only cancel when the rejected frame is the one that armed the fallback
    // (or either side has no ts to compare).
    const armedTs = pendingTs.get(uasId) ?? null;
    if (armedTs !== null && ts !== null && armedTs !== ts) continue;
    clearTimeout(timer);
    pendingFallbacks.delete(uasId);
    pendingTs.delete(uasId);
    // The alert never fired, so a genuine later sighting may still alert.
    notified.delete(uasId);
    changed = true;
    console.log(`[droneNotifier] fallback cancelled — backend rejected uas=${uasId} ts=${ts} reason=${r.reason ?? 'stale'}`);
  }
  if (changed) schedulePersist();
}

export function initDroneNotifications(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowAlert: true,
          shouldShowBanner: true,
          shouldShowList: true,
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
              pendingTs.delete(pushUasId);
              acceptedWhilePending.delete(pushUasId);
            }
          } catch {}
        });
      } catch (err) {
        console.warn('[droneNotifier] cross-ref listener failed to attach:', err);
      }

      // Per-drone verdicts from the native uploaders (Android
      // DetectionUploader / iOS WSWDetectionUploader).
      try {
        uploadResultSub = DeviceEventEmitter.addListener(
          'DetectionUploadResult',
          (e: { accepted?: string[]; rejected?: UploadRejection[] }) =>
            applyUploadResult(e?.accepted ?? [], e?.rejected ?? []),
        );
      } catch (err) {
        console.warn('[droneNotifier] upload-result listener failed to attach:', err);
      }

      await ensureLoaded();

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

// `odidTs` is the frame's ODID Location timestamp (deciseconds since the UTC
// hour), when the parser has one.
export async function notifyNewDrone(uasId: string, odidTs?: number | null): Promise<void> {
  if (!uasId) return;
  const ts = validTs(odidTs);
  // (1) Stale per its own ODID clock — never alert. Not recorded, so a fresh
  // frame of the same drone can still alert.
  if (!isOdidFresh(ts)) return;

  await ensureLoaded();
  // (2) The backend already rejected this exact frame.
  if (ts !== null && rejectedFrames.has(`${uasId}:${ts}`)) return;
  // (3) Same frame already alerted, or this drone alerted recently.
  const prev = notified.get(uasId);
  if (prev && ((ts !== null && prev.ts === ts) || Date.now() - prev.at < NOTIFY_COOLDOWN_MS)) return;

  // Don't even start a timer if permission denied — saves the
  // 8-second wait and the eventual no-op fire.
  if (permissionStatus !== 'granted') return;

  // Already pending? Coalesce — keep the existing timer.
  if (pendingFallbacks.has(uasId)) return;

  notified.set(uasId, { at: Date.now(), ts });
  schedulePersist();
  pendingTs.set(uasId, ts);
  acceptedWhilePending.delete(uasId);
  const timer = setTimeout(() => {
    pendingFallbacks.delete(uasId);
    pendingTs.delete(uasId);
    acceptedWhilePending.delete(uasId);
    void fireFallbackNotification(uasId);
  }, FALLBACK_TIMEOUT_MS);
  pendingFallbacks.set(uasId, timer);
}

// Clear pending timers. Call on logout, BLE scan stop, or any other
// "session reset" event. The persisted dedup (same frame / cooldown) is
// deliberately kept — wiping it on every session reset is what let a restart
// re-alert on the same ghost frame; a genuine re-approach alerts again once
// the cooldown passes.
export function resetNotifiedDrones(): void {
  for (const [uasId, timer] of pendingFallbacks) {
    clearTimeout(timer);
    // Armed but never fired — don't let the cooldown swallow the next sighting.
    notified.delete(uasId);
  }
  pendingFallbacks.clear();
  pendingTs.clear();
  acceptedWhilePending.clear();
  schedulePersist();
}

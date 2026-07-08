// JS-side node-less detection upload (iOS relay path).
//
// On Android, detections POST from the Kotlin foreground service keyed on the
// node MAC (/api/nodes/<deviceId>/detections). On iOS the DroneScout-bridge /
// DJI detections assembled in bleScanner.ts have NO Westshore node MAC, so the
// native WSWDetectionUploader (keyed on deviceId) never sees them. This module
// is the iOS-only, node-less upload path: it batches + coalesces the assembled
// detections and POSTs them to a deployment the user is operating, via
// api.deploymentDetections (which carries the user JWT + X-Client-* headers).
//
// Events (DeviceEventEmitter, consumed elsewhere):
//   DeploymentPaused  / DeploymentResumed   — 402 billing pause + recovery,
//       reuse the native uploader's contract so LiveMapScreen's paused banner
//       lights up without knowing this path exists.
//   RelayTargetRejected                     — 403/404: the relay deployment is
//       out of scope; useRelayTarget clears the target so we stop enqueuing.

import { DeviceEventEmitter } from 'react-native';
import { api } from './api';

export interface UploadRecord {
  id: string;          // uasId
  lat: number;
  lon: number;
  alt?: number | null; // geodetic altitude (m)
  spd?: number | null; // horizontal speed (m/s)
  hdg?: number | null; // heading (deg)
  op_lat?: number | null;
  op_lon?: number | null;
  ts?: number | null;  // ODID Location timestamp (deciseconds since the UTC hour)
}

// Mirror the native uploader's flush cadence and per-bucket cap so the backend
// sees the same arrival shape regardless of relay platform.
const FLUSH_INTERVAL_MS = 500;
const MAX_PER_DEPLOYMENT = 200;

// Backoff for 402 (billing) and transient (network/5xx) failures: double from
// 5s to a 60s cap, reset on the next 2xx. Mirrors WSWDetectionUploader.
const BACKOFF_INITIAL_MS = 5000;
const BACKOFF_CAP_MS = 60000;

// deploymentId -> (uasId -> latest record). Coalesces repeat sightings within a
// flush window to the most recent reading per drone, matching WSWDetectionUploader.
const queue = new Map<string, Map<string, UploadRecord>>();
let flushTimer: ReturnType<typeof setInterval> | null = null;

// Flush sits out until this wall-clock time (ms) after a 402 or transient
// failure, so we don't hammer a paused/failing backend.
let holdUntil = 0;
let backoffMs = 0;
// True after a 402 so the next 2xx emits DeploymentResumed exactly once.
let billingPaused = false;
// One-time full-payload log of the first POST body (Gate 2: eyeball that `ts`
// is populated in a real outgoing request), then revert to the terse line.
let loggedFirstPayload = false;

export function enqueueDetectionUpload(deploymentId: string, record: UploadRecord): void {
  let bucket = queue.get(deploymentId);
  if (!bucket) {
    bucket = new Map();
    queue.set(deploymentId, bucket);
  }
  // Cap-bounded: once full, only update drones already in the bucket (matches
  // the native enqueue), so a flood of new uasIds can't grow the batch unbounded.
  if (bucket.size >= MAX_PER_DEPLOYMENT && !bucket.has(record.id)) return;
  bucket.set(record.id, record);
  ensureFlushTimer();
}

function ensureFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flushOnce, FLUSH_INTERVAL_MS);
}

// Called when scanning stops. Drops the in-memory queue (the app is
// session-based; queue loss on stop is acceptable, same as the native side) and
// resets the pause/backoff state so the next session starts clean. The
// first-payload log flag is left set — it's one-time per app session.
export function stopDetectionUpload(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  queue.clear();
  holdUntil = 0;
  backoffMs = 0;
  billingPaused = false;
}

function flushOnce(): void {
  if (queue.size === 0) {
    // Nothing pending — stop spinning the timer; enqueue restarts it.
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    return;
  }
  // Sit out a 402 / transient backoff without hammering the backend.
  if (Date.now() < holdUntil) return;

  // Drain a snapshot so enqueue during the async POST goes to a fresh bucket.
  const snapshot: Array<[string, UploadRecord[]]> = [];
  for (const [deploymentId, bucket] of queue) {
    snapshot.push([deploymentId, Array.from(bucket.values())]);
  }
  queue.clear();

  for (const [deploymentId, drones] of snapshot) {
    if (drones.length === 0) continue;
    void postBatch(deploymentId, drones);
  }
}

function bumpBackoff(): void {
  backoffMs = backoffMs === 0 ? BACKOFF_INITIAL_MS : Math.min(backoffMs * 2, BACKOFF_CAP_MS);
  holdUntil = Date.now() + backoffMs;
}

// Put a failed batch back, cap-bounded, without clobbering a fresher reading
// that arrived while the POST was in flight. Restarts the flush timer (it was
// stopped when the queue drained); the holdUntil gate defers the actual retry.
function requeue(deploymentId: string, drones: UploadRecord[]): void {
  let bucket = queue.get(deploymentId);
  if (!bucket) {
    bucket = new Map();
    queue.set(deploymentId, bucket);
  }
  for (const d of drones) {
    if (bucket.size >= MAX_PER_DEPLOYMENT && !bucket.has(d.id)) break;
    if (!bucket.has(d.id)) bucket.set(d.id, d);
  }
  ensureFlushTimer();
}

async function postBatch(deploymentId: string, drones: UploadRecord[]): Promise<void> {
  const body = drones.map(d => ({
    id: d.id, lat: d.lat, lon: d.lon,
    alt: d.alt ?? null, spd: d.spd ?? null, hdg: d.hdg ?? null,
    op_lat: d.op_lat ?? null, op_lon: d.op_lon ?? null, ts: d.ts ?? null,
  }));

  if (!loggedFirstPayload) {
    loggedFirstPayload = true;
    console.log(
      `[detectionUpload] first POST /api/deployments/${deploymentId}/detections body=` +
      JSON.stringify({ drones: body }),
    );
  }

  try {
    await api.deploymentDetections(deploymentId, body);
    // 2xx: batch is already drained from the queue, so just clear backoff and
    // emit Resumed if we were billing-paused.
    backoffMs = 0;
    holdUntil = 0;
    if (billingPaused) {
      billingPaused = false;
      DeviceEventEmitter.emit('DeploymentResumed', {});
    }
    console.log(`[detectionUpload] POST ok deployment=${deploymentId} drones=${drones.length}`);
  } catch (err: any) {
    // request() attaches the HTTP status; a thrown network error has none.
    const status: number | undefined = err?.status;
    if (status === 402) {
      // Billing paused: hold + surface the banner, keep the batch for later.
      requeue(deploymentId, drones);
      bumpBackoff();
      billingPaused = true;
      DeviceEventEmitter.emit('DeploymentPaused', { deployment_id: deploymentId });
      console.warn(`[detectionUpload] 402 billing paused deployment=${deploymentId} — holding ${backoffMs}ms`);
    } else if (status === 403 || status === 404) {
      // Scope rejected by the server. Drop this batch (don't retry blindly) and
      // tell useRelayTarget to clear the relay target so we stop enqueuing.
      stopDetectionUpload();
      DeviceEventEmitter.emit('RelayTargetRejected', { deployment_id: deploymentId, status });
      console.warn(`[detectionUpload] ${status} relay target out of scope deployment=${deploymentId} — cleared target, stopped`);
    } else {
      // Network error or 5xx / other transient: requeue with backoff, never
      // drop detections on a recoverable failure.
      requeue(deploymentId, drones);
      bumpBackoff();
      console.warn(`[detectionUpload] transient POST failure deployment=${deploymentId} status=${status ?? 'network'} — requeueing, holding ${backoffMs}ms`);
    }
  }
}

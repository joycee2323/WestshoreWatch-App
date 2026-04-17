import * as SecureStore from 'expo-secure-store';
import { api } from './api';
import { getDeviceIdFromMac } from './nodeRegistry';

const FLUSH_INTERVAL_MS = 2000;

export interface QueueInput {
  sourceMac: string;
  uasId: string;
  lat: number;
  lon: number;
  altGeo?: number;
  rssi: number;
  opLat?: number;
  opLon?: number;
  speedHoriz?: number;
  heading?: number;
  timestamp?: number;
}

interface DroneRecord {
  id: string;
  lat: number;
  lon: number;
  alt: number | null;
  spd: number | null;
  hdg: number | null;
  op_lat: number | null;
  op_lon: number | null;
}

// Per-deviceId buffer keyed by uasId so repeat sightings within a flush
// window collapse to the latest reading instead of N separate POSTs.
const queue = new Map<string, Map<string, DroneRecord>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const loggedMissingNodes = new Set<string>();

function finiteOrNull(n: number | undefined): number | null {
  return Number.isFinite(n) ? (n as number) : null;
}

export function queueDetection(input: QueueInput): void {
  if (!input.sourceMac || !input.uasId) return;
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lon)) return;
  if (input.lat === 0 && input.lon === 0) return;

  const deviceId = getDeviceIdFromMac(input.sourceMac);
  const drone: DroneRecord = {
    id: input.uasId,
    lat: input.lat,
    lon: input.lon,
    alt: finiteOrNull(input.altGeo),
    spd: finiteOrNull(input.speedHoriz),
    hdg: finiteOrNull(input.heading),
    op_lat: finiteOrNull(input.opLat),
    op_lon: finiteOrNull(input.opLon),
  };

  let bucket = queue.get(deviceId);
  if (!bucket) {
    bucket = new Map();
    queue.set(deviceId, bucket);
  }
  bucket.set(input.uasId, drone);

  if (!flushTimer) {
    flushTimer = setTimeout(() => { void flush(); }, FLUSH_INTERVAL_MS);
  }
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (queue.size === 0) return;

  const userToken = await SecureStore.getItemAsync('auth_token');
  if (!userToken) {
    queue.clear();
    return;
  }

  const batches = Array.from(queue.entries());
  queue.clear();

  await Promise.all(batches.map(async ([deviceId, bucket]) => {
    const drones = Array.from(bucket.values());
    if (!drones.length) return;
    try {
      await api.nodeDetections(deviceId, drones);
    } catch (e: any) {
      if (e?.status === 404) {
        if (!loggedMissingNodes.has(deviceId)) {
          loggedMissingNodes.add(deviceId);
          console.warn(`[detectionUploader] node ${deviceId} not found, dropping detections (logged once per session)`);
        }
        return;
      }
      console.warn('[detectionUploader] upload failed:', e?.message ?? e);
    }
  }));
}

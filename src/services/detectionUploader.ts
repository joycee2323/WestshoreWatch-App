import * as SecureStore from 'expo-secure-store';

const BASE = 'https://airaware-backend-6jz6.onrender.com/api';
const DEDUPE_WINDOW_MS = 5000;

const lastUploadByUas = new Map<string, number>();

export interface UploadInput {
  nodeApiKey: string;
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

function finiteOrNull(n: number | undefined): number | null {
  return Number.isFinite(n) ? (n as number) : null;
}

export async function uploadDetection(input: UploadInput): Promise<void> {
  if (!input.nodeApiKey || !input.uasId) return;
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lon)) return;
  if (input.lat === 0 && input.lon === 0) return;

  // Only upload when the user is logged in — presence of the user JWT gates uploads,
  // but the request itself authenticates with the node api_key.
  const userToken = await SecureStore.getItemAsync('auth_token');
  if (!userToken) return;

  const now = Date.now();
  const last = lastUploadByUas.get(input.uasId) ?? 0;
  if (now - last < DEDUPE_WINDOW_MS) return;
  lastUploadByUas.set(input.uasId, now);

  const body = {
    drones: [
      {
        id: input.uasId,
        lat: input.lat,
        lon: input.lon,
        alt: finiteOrNull(input.altGeo),
        spd: finiteOrNull(input.speedHoriz),
        hdg: finiteOrNull(input.heading),
        op_lat: finiteOrNull(input.opLat),
        op_lon: finiteOrNull(input.opLon),
      },
    ],
  };

  try {
    const res = await fetch(`${BASE}/detections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-node-api-key': input.nodeApiKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.log('[detectionUploader] response:', res.status, await res.text());
    }
  } catch (e) {
    console.warn('[detectionUploader] network error:', e);
  }
}

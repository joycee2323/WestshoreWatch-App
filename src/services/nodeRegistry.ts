import { api } from './api';

export interface NodeInfo {
  id: string;
  name: string;
  device_id: string;
  deployment_id: string | null;
  last_lat: number | null;
  last_lon: number | null;
  last_seen: string | null;
  status: string;
  connection_type: string | null;
  firmware_version: string | null;
}

const cache = new Map<string, NodeInfo>();
let inFlight: Promise<NodeInfo[]> | null = null;
// Bumped on clearCache so an in-flight fetch issued before logout
// cannot repopulate the cache with the previous user's nodes.
let generation = 0;

export function getDeviceIdFromMac(mac: string): string {
  return mac.replace(/:/g, '').replace(/-/g, '').toUpperCase();
}

export function getNodeByMac(mac: string): NodeInfo | null {
  return cache.get(getDeviceIdFromMac(mac)) ?? null;
}

export function getNodeByDeviceId(deviceId: string): NodeInfo | null {
  return cache.get(deviceId.toUpperCase()) ?? null;
}

export async function fetchNodes(): Promise<NodeInfo[]> {
  if (inFlight) return inFlight;
  const myGen = generation;
  inFlight = (async () => {
    try {
      const list: NodeInfo[] = await api.getNodes();
      if (myGen !== generation) return list;
      cache.clear();
      for (const n of list) {
        if (n?.device_id) cache.set(n.device_id.toUpperCase(), n);
      }
      return list;
    } catch (e) {
      console.warn('[nodeRegistry] fetchNodes failed:', e);
      return [];
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function clearCache(): void {
  cache.clear();
  generation++;
  inFlight = null;
}

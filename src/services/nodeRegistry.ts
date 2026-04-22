import { api } from './api';
import { getDiscoveredNodes, DiscoveredNode } from './bleScanner';

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

// Nearby MACs the scanner has seen that are NOT in the user's org's node list.
// Fuel for the Add Node screen. Pulls live from bleScanner's discoveredNodes
// (populated by the always-on 0x08FE manufacturer-data scan filter), so results
// are available immediately on screen open without a fresh scan cycle.
export function getUnclaimedNearby(): DiscoveredNode[] {
  const nearby = getDiscoveredNodes();
  const unclaimed: DiscoveredNode[] = [];
  for (const [mac, info] of nearby) {
    const deviceId = getDeviceIdFromMac(mac);
    if (!cache.has(deviceId)) unclaimed.push(info);
  }
  return unclaimed.sort((a, b) => b.rssi - a.rssi);
}

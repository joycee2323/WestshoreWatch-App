import { NativeModules, NativeEventEmitter, Platform, EmitterSubscription } from 'react-native';
import { parseOdidAdvertisement, OdidDetection } from './odidParser';
import { queueDetection } from './detectionUploader';
import { notifyNewDrone } from './droneNotifier';

const { BLEScanner } = NativeModules as {
  BLEScanner?: {
    startService: () => Promise<void>;
    stopService: () => Promise<void>;
    addListener: (eventName: string) => void;
    removeListeners: (count: number) => void;
  };
};

interface NativeScanResult {
  mac: string;
  rssi: number;
  name: string | null;
  serviceData: Record<string, string>;
  serviceUUIDs: string[];
  manufacturerData: string | null;
  rawScanRecord: string | null;
}

async function startForegroundService(): Promise<void> {
  if (Platform.OS !== 'android' || !BLEScanner) return;
  try {
    await BLEScanner.startService();
    console.log('[BLE] Foreground service started successfully');
  } catch (e) {
    console.warn('[BLE] Failed to start foreground service:', e);
  }
}

async function stopForegroundService(): Promise<void> {
  if (Platform.OS !== 'android' || !BLEScanner) return;
  try {
    await BLEScanner.stopService();
  } catch (e) {
    console.warn('[BLE] Failed to stop foreground service:', e);
  }
}

let scanning = false;
let subscription: EmitterSubscription | null = null;

export interface DiscoveredNode {
  mac: string;
  rssi: number;
  lastSeen: number;
}

const discoveredNodes = new Map<string, DiscoveredNode>();

// ODID messages arrive in separate ads: BasicId carries uasId, Location carries lat/lon,
// System carries operator lat/lon. We merge per source MAC to reconstruct a full detection.
interface OdidMergeState {
  uasId?: string;
  lat?: number;
  lon?: number;
  altGeo?: number;
  speedHoriz?: number;
  heading?: number;
  opLat?: number;
  opLon?: number;
  updatedAt: number;
}
const ODID_MERGE_TTL_MS = 30_000;
const mergeBySource = new Map<string, OdidMergeState>();

export function getDiscoveredNodes(): Map<string, DiscoveredNode> {
  return discoveredNodes;
}

let onNodeNearby: ((mac: string, rssi: number) => void) | null = null;

function isAirAwareNode(mac: string): boolean {
  const upper = mac.toUpperCase();
  return upper.startsWith('98:A3:16:7D') || upper.startsWith('38:44:BE');
}

export async function startBleScanning(
  onDetection: (det: Partial<OdidDetection> & { mac: string; rssi: number; sourceMac?: string }) => void,
  onNearbyNode?: (mac: string, rssi: number) => void,
): Promise<void> {
  if (scanning) return;
  if (Platform.OS !== 'android' || !BLEScanner) {
    console.warn('[BLE] Native BLEScanner module unavailable');
    return;
  }
  onNodeNearby = onNearbyNode || null;

  const emitter = new NativeEventEmitter(BLEScanner as any);
  subscription = emitter.addListener('BLEScanResult', (device: NativeScanResult) => {
    if (!device || !device.mac) return;
    const rssi = device.rssi ?? -100;
    const now = Date.now();
    const mac = device.mac;

    if (isAirAwareNode(mac)) {
      const macUpper = mac.toUpperCase();
      discoveredNodes.set(macUpper, {
        mac: macUpper,
        rssi,
        lastSeen: now,
      });
      if (onNodeNearby) onNodeNearby(macUpper, rssi);
    }

    const serviceDataMap = device.serviceData;
    if (!serviceDataMap) return;

    const ODID_UUID_KEY = '0000fffa-0000-1000-8000-00805f9b34fb';
    const serviceData = serviceDataMap[ODID_UUID_KEY];
    if (!serviceData) return;

    const parsed = parseOdidAdvertisement(mac, rssi, serviceData);
    if (!parsed) return;

    if (parsed.uasId === 'DroneScout Bridge') return;

    // Can't attribute a message with no UAS ID — two drones relayed through
    // one node would collapse into each other's merge state. A subsequent
    // BasicId or Pack from the same drone will carry the fields we need.
    if (!parsed.uasId) return;

    const sourceMacUpper = mac.toUpperCase();

    // Merge with prior parses for this UAS ID — BasicId, Location, and System
    // each only carry some of the fields. Keyed by uasId (not source MAC) so
    // multiple drones relayed through one node stay separate.
    const prev = mergeBySource.get(parsed.uasId);
    const stale = !prev || (now - prev.updatedAt) > ODID_MERGE_TTL_MS;
    const merged: OdidMergeState = {
      ...(stale ? {} : prev),
      uasId: parsed.uasId,
      ...(parsed.hasLocation && typeof parsed.lat === 'number' && typeof parsed.lon === 'number'
        ? { lat: parsed.lat, lon: parsed.lon, altGeo: parsed.altGeo,
            speedHoriz: parsed.speedHoriz, heading: parsed.heading }
        : {}),
      ...(parsed.hasSystem ? { opLat: parsed.opLat, opLon: parsed.opLon } : {}),
      updatedAt: now,
    };
    mergeBySource.set(parsed.uasId, merged);

    // Fire a notification the first time we see this UAS ID (fresh cache entry).
    // droneNotifier dedupes per session — repeat sightings are ignored there too.
    if (stale) {
      void notifyNewDrone(parsed.uasId);
    }

    onDetection({
      mac,
      uasId: parsed.uasId,
      rssi,
      lastSeen: now,
      sourceMac: sourceMacUpper,
      ...parsed,
    });

    // Only queue uploads from AirAware-OUI sources. Drones broadcasting
    // their own ODID directly aren't node-attributable, so the backend
    // would 404 on /nodes/<droneMac>/detections.
    if (
      isAirAwareNode(sourceMacUpper) &&
      merged.uasId &&
      typeof merged.lat === 'number' &&
      typeof merged.lon === 'number' &&
      !(merged.lat === 0 && merged.lon === 0)
    ) {
      queueDetection({
        sourceMac: sourceMacUpper,
        uasId: merged.uasId,
        lat: merged.lat,
        lon: merged.lon,
        altGeo: merged.altGeo,
        rssi,
        opLat: merged.opLat,
        opLon: merged.opLon,
        speedHoriz: merged.speedHoriz,
        heading: merged.heading,
        timestamp: now,
      });
    }
  });

  await startForegroundService();
  scanning = true;
}

export function stopBleScanning(): void {
  if (!scanning) return;
  subscription?.remove();
  subscription = null;
  scanning = false;
  void stopForegroundService();
}

export function isBleScanning(): boolean {
  return scanning;
}

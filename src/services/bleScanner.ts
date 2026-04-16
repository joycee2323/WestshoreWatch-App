import { NativeModules, NativeEventEmitter, Platform, EmitterSubscription } from 'react-native';
import { parseOdidAdvertisement, OdidDetection } from './odidParser';
import { uploadDetection } from './detectionUploader';
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

const NODE_API_KEYS: Record<string, string> = {
  '98:A3:16:7D:26:34': 'fe4e6448-e10e-45bf-b6b1-1b524bdfd173',
  '98:A3:16:7D:26:36': 'fe4e6448-e10e-45bf-b6b1-1b524bdfd173',
  '98:A3:16:7D:26:62': '99c169eb52748d90e60c4c6765767282597077fc6514b627ba58b09439ce3acd',
  '98:A3:16:7D:26:61': '99c169eb52748d90e60c4c6765767282597077fc6514b627ba58b09439ce3acd',
  '38:44:BE:A5:78:EA': '68f4f41c7a4cb64a1ce64365b91bb679ea25c3c5d01521f3636992608fd2776e',
  '38:44:BE:A5:79:46': '35695170236abaca973c419d5c3d60e42859c0eb2f587aa460e0e02f1303da37',
};

let scanning = false;
let subscription: EmitterSubscription | null = null;

export interface DiscoveredNode {
  mac: string;
  apiKey: string;
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

let onNodeNearby: ((mac: string, rssi: number, apiKey?: string) => void) | null = null;

function isAirAwareNode(mac: string): boolean {
  const upper = mac.toUpperCase();
  return upper.startsWith('98:A3:16:7D') || upper.startsWith('38:44:BE');
}

export async function startBleScanning(
  onDetection: (det: Partial<OdidDetection> & { mac: string; rssi: number }) => void,
  onNearbyNode?: (mac: string, rssi: number, apiKey?: string) => void,
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
      const apiKey = NODE_API_KEYS[macUpper];

      if (apiKey) {
        discoveredNodes.set(macUpper, {
          mac: macUpper,
          apiKey,
          rssi,
          lastSeen: now,
        });
        if (onNodeNearby) onNodeNearby(macUpper, rssi, apiKey);
      } else {
        console.warn(
          `[BLE] AirAware OUI device (${macUpper}) has no API key in NODE_API_KEYS table`,
        );
        if (onNodeNearby) onNodeNearby(macUpper, rssi);
      }
    }

    const serviceDataMap = device.serviceData;
    if (!serviceDataMap) return;

    const ODID_UUID_KEY = '0000fffa-0000-1000-8000-00805f9b34fb';
    const serviceData = serviceDataMap[ODID_UUID_KEY];
    if (!serviceData) return;

    const parsed = parseOdidAdvertisement(mac, rssi, serviceData);
    if (!parsed) return;

    if (parsed.uasId === 'DroneScout Bridge') return;

    const sourceMacUpper = mac.toUpperCase();
    const sourceApiKey = NODE_API_KEYS[sourceMacUpper];

    // Merge with prior parses from this source — BasicId, Location, and System
    // each only carry some of the fields.
    const prev = mergeBySource.get(sourceMacUpper);
    const stale = !prev || (now - prev.updatedAt) > ODID_MERGE_TTL_MS;
    const merged: OdidMergeState = {
      ...(stale ? {} : prev),
      ...(parsed.uasId !== undefined ? { uasId: parsed.uasId } : {}),
      ...(parsed.hasLocation && typeof parsed.lat === 'number' && typeof parsed.lon === 'number'
        ? { lat: parsed.lat, lon: parsed.lon, altGeo: parsed.altGeo,
            speedHoriz: parsed.speedHoriz, heading: parsed.heading }
        : {}),
      ...(parsed.hasSystem ? { opLat: parsed.opLat, opLon: parsed.opLon } : {}),
      updatedAt: now,
    };
    mergeBySource.set(sourceMacUpper, merged);

    // Fire a notification the first time we see this UAS ID (fresh cache entry).
    // droneNotifier dedupes per session — repeat sightings are ignored there too.
    if (parsed.uasId && (stale || prev?.uasId !== parsed.uasId)) {
      void notifyNewDrone(parsed.uasId);
    }

    onDetection({
      mac,
      rssi,
      lastSeen: now,
      sourceMac: sourceMacUpper,
      sourceApiKey,
      ...parsed,
    });

    // Upload when the merged state has both an id and a real location.
    if (
      sourceApiKey &&
      merged.uasId &&
      typeof merged.lat === 'number' &&
      typeof merged.lon === 'number' &&
      !(merged.lat === 0 && merged.lon === 0)
    ) {
      void uploadDetection({
        nodeApiKey: sourceApiKey,
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

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

// DJI (and most drones in practice) broadcast BasicId — the only message that
// carries uasId — every ~30s, while Location and System broadcast every ~2s
// without a uasId. To attribute position-only messages to a drone, we remember
// the most recently seen uasId on each source (relay) MAC, and apply it to
// subsequent Location/System messages on that MAC within this TTL. When two
// drones share one node, attribution follows whichever broadcast BasicId last,
// so positions will flicker between the two — accepted tradeoff until DJI
// provides a stronger attribution signal.
const ATTRIBUTION_TTL_MS = 60_000;
const mergeBySource = new Map<string, { uasId: string; lastBasicIdAt: number }>();

export function getDiscoveredNodes(): Map<string, DiscoveredNode> {
  return discoveredNodes;
}

let onNodeNearby: ((mac: string, rssi: number) => void) | null = null;

function isWestshore WatchNode(mac: string): boolean {
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
    const serviceDataMap = device.serviceData;

    if (isWestshore WatchNode(mac)) {
      const macUpper = mac.toUpperCase();
      discoveredNodes.set(macUpper, {
        mac: macUpper,
        rssi,
        lastSeen: now,
      });
      if (onNodeNearby) onNodeNearby(macUpper, rssi);
    }

    if (!serviceDataMap) return;

    const ODID_UUID_KEY = '0000fffa-0000-1000-8000-00805f9b34fb';
    const serviceData = serviceDataMap[ODID_UUID_KEY];
    if (!serviceData) return;

    const parsed = parseOdidAdvertisement(mac, rssi, serviceData);
    if (!parsed) return;

    if (parsed.uasId === 'DroneScout Bridge') return;

    const sourceMacUpper = mac.toUpperCase();

    // Attribute the uasId. BasicId/Pack messages carry their own uasId and
    // refresh the attribution for this source. Location/System messages have
    // no uasId of their own — inherit the most recent one on this source MAC
    // if it's within the TTL.
    let effectiveUasId: string | undefined;
    if (parsed.uasId) {
      effectiveUasId = parsed.uasId;
      const prev = mergeBySource.get(sourceMacUpper);
      const isNewSighting = !prev
        || prev.uasId !== parsed.uasId
        || (now - prev.lastBasicIdAt) > ATTRIBUTION_TTL_MS;
      mergeBySource.set(sourceMacUpper, { uasId: parsed.uasId, lastBasicIdAt: now });
      if (isNewSighting) {
        void notifyNewDrone(parsed.uasId);
      }
    } else {
      const prev = mergeBySource.get(sourceMacUpper);
      if (prev && (now - prev.lastBasicIdAt) <= ATTRIBUTION_TTL_MS) {
        effectiveUasId = prev.uasId;
      }
    }

    if (!effectiveUasId) return;

    onDetection({
      mac,
      rssi,
      lastSeen: now,
      sourceMac: sourceMacUpper,
      ...parsed,
      uasId: effectiveUasId,
    });

    // Only queue uploads from Westshore Watch-OUI sources. Drones broadcasting
    // their own ODID directly aren't node-attributable, so the backend
    // would 404 on /nodes/<droneMac>/detections. Use the current message's
    // position fields (parsed) with the attributed uasId.
    if (
      isWestshore WatchNode(sourceMacUpper) &&
      typeof parsed.lat === 'number' &&
      typeof parsed.lon === 'number' &&
      !(parsed.lat === 0 && parsed.lon === 0)
    ) {
      queueDetection({
        sourceMac: sourceMacUpper,
        uasId: effectiveUasId,
        lat: parsed.lat,
        lon: parsed.lon,
        altGeo: parsed.altGeo,
        rssi,
        opLat: parsed.opLat,
        opLon: parsed.opLon,
        speedHoriz: parsed.speedHoriz,
        heading: parsed.heading,
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

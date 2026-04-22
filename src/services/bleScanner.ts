import { NativeModules, NativeEventEmitter, Platform, EmitterSubscription } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { parseOdidAdvertisement, OdidDetection } from './odidParser';
import { notifyNewDrone } from './droneNotifier';

const { BLEScanner } = NativeModules as {
  BLEScanner?: {
    startService: () => Promise<void>;
    stopService: () => Promise<void>;
    configure: (config: { baseUrl?: string; authToken?: string | null }) => Promise<void>;
    addListener: (eventName: string) => void;
    removeListeners: (count: number) => void;
  };
};

const UPLOAD_BASE_URL = 'https://api.westshoredrone.com';

// Push the current bearer token into the native uploader. Called on login,
// logout, token refresh, and right before we start scanning so the Kotlin
// service can POST detections without waiting for the JS thread (which Doze
// suspends when the screen is off).
export async function configureNativeUpload(token: string | null): Promise<void> {
  if (Platform.OS !== 'android' || !BLEScanner?.configure) return;
  try {
    await BLEScanner.configure({ baseUrl: UPLOAD_BASE_URL, authToken: token });
  } catch (e) {
    console.warn('[BLE] configureNativeUpload failed:', e);
  }
}

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

function isWestshoreWatchNode(mac: string): boolean {
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

    if (isWestshoreWatchNode(mac)) {
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

    // Uploads happen in Kotlin (DetectionUploader) so they survive Doze.
    // The JS parse/emit path above is retained only for UI state.
  });

  // Prime the native uploader with the current token before scanning so the
  // first batch inside the service has what it needs to POST.
  const token = await SecureStore.getItemAsync('auth_token');
  await configureNativeUpload(token);
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

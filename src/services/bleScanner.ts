import { NativeModules, NativeEventEmitter, Platform, EmitterSubscription } from 'react-native';
import { parseOdidAdvertisement, OdidDetection } from './odidParser';

const { BLEScanner } = NativeModules as {
  BLEScanner?: {
    startService: () => Promise<void>;
    stopService: () => Promise<void>;
    addListener: (eventName: string) => void;
    removeListeners: (count: number) => void;
  };
};
console.log('[BLE] NativeModules.BLEScanner:', BLEScanner);

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

export function getDiscoveredNodes(): Map<string, DiscoveredNode> {
  return discoveredNodes;
}

let onNodeNearby: ((mac: string, rssi: number, apiKey?: string) => void) | null = null;

function isAirAwareNode(mac: string): boolean {
  return mac.toUpperCase().startsWith('98:A3:16:7D');
}

export async function startBleScanning(
  onDetection: (det: Partial<OdidDetection> & { mac: string; rssi: number }) => void,
  onNearbyNode?: (mac: string, rssi: number, apiKey?: string) => void,
): Promise<void> {
  console.log('[BLE] startBleScanning called');
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
      console.log('[BLE AirAware]', mac, JSON.stringify({
        name: device.name,
        manufacturerData: device.manufacturerData,
        serviceData: device.serviceData,
        serviceUUIDs: device.serviceUUIDs,
        rawScanRecord: device.rawScanRecord,
      }));
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

    console.log('[ODID input]', mac, serviceData);
    const parsed = parseOdidAdvertisement(mac, rssi, serviceData);
    console.log('[ODID parsed]', mac, parsed);
    if (!parsed) return;

    if (parsed.uasId === 'DroneScout Bridge') return;

    onDetection({
      mac,
      rssi,
      lastSeen: now,
      sourceMac: mac.toUpperCase(),
      sourceApiKey: NODE_API_KEYS[mac.toUpperCase()],
      ...parsed,
    });
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

import { BleManager, Device, State } from 'react-native-ble-plx';
import { Platform } from 'react-native';
import BackgroundService from 'react-native-background-actions';
import { parseOdidAdvertisement, OdidDetection } from './odidParser';
import { useDroneStore } from '../store/droneStore';

const ODID_SERVICE_UUID = '0000FFFA-0000-1000-8000-00805F9B34FB';

// Hardcoded MAC → API key table for AirAware nodes.
// Both manufacturerData and device.name are null for extended BLE
// advertisements on Android, so we identify nodes by OUI prefix on
// device.id (which is the MAC on Android) and look up the API key here.
const NODE_API_KEYS: Record<string, string> = {
  '98:A3:16:7D:26:34': 'fe4e6448-e10e-45bf-b6b1-1b524bdfd173',
  '98:A3:16:7D:26:36': 'fe4e6448-e10e-45bf-b6b1-1b524bdfd173',
  // COM5 — BLE MAC + softAP MAC fallback
  '98:A3:16:7D:26:62': '99c169eb52748d90e60c4c6765767282597077fc6514b627ba58b09439ce3acd',
  '98:A3:16:7D:26:61': '99c169eb52748d90e60c4c6765767282597077fc6514b627ba58b09439ce3acd',
};

let bleManager: BleManager | null = null;
let scanning = false;

function getBleManager(): BleManager {
  if (!bleManager) {
    bleManager = new BleManager();
  }
  return bleManager;
}

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
  if (scanning) return;
  onNodeNearby = onNearbyNode || null;
  const manager = getBleManager();

  // Wait for BLE to power on
  await new Promise<void>((resolve, reject) => {
    const sub = manager.onStateChange((state) => {
      if (state === State.PoweredOn) {
        sub.remove();
        resolve();
      } else if (state === State.PoweredOff || state === State.Unsupported) {
        sub.remove();
        reject(new Error('Bluetooth not available'));
      }
    }, true);
  });

  scanning = true;

  manager.startDeviceScan(
    null, // scan all devices so we catch node MAC addresses too
    { allowDuplicates: true, scanMode: 2 /* SCAN_MODE_LOW_LATENCY */ },
    (error, device) => {
      if (error) {
        console.warn('BLE scan error:', error);
        return;
      }
      if (!device || !device.id) return;

      const rssi = device.rssi ?? -100;
      const now = Date.now();
      const mac = device.id;

      // 1) AirAware node detection via OUI prefix on device.id (MAC).
      //    Both manufacturerData and device.name are null for extended
      //    advertisements on Android, so we match by OUI and look up the
      //    API key from the hardcoded NODE_API_KEYS table.
      //    NOTE: Do NOT return here — the same advertisement may carry
      //    relayed ODID service data that still needs to be parsed below.
      if (isAirAwareNode(mac)) {
        console.log('[BLE AirAware]', mac, JSON.stringify({
          name: device.name,
          manufacturerData: device.manufacturerData,
          serviceData: device.serviceData,
          serviceUUIDs: device.serviceUUIDs,
          rawScanRecord: (device as any).rawScanRecord,
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
        // Fall through to check for relayed ODID service data
      }

      // 2) Parse ODID service data (drone broadcasts, including relays from AirAware nodes)
      const serviceDataMap = device.serviceData;
      if (!serviceDataMap) return;

      const ODID_UUID_KEY = '0000fffa-0000-1000-8000-00805f9b34fb';
      const serviceData = serviceDataMap[ODID_UUID_KEY];
      if (!serviceData) return;

      console.log('[ODID input]', mac, serviceData);
      const parsed = parseOdidAdvertisement(mac, rssi, serviceData);
      console.log('[ODID parsed]', mac, parsed);
      if (!parsed) return;

      // Skip DroneScout Bridge advertisements — not a real drone
      if (parsed.uasId === 'DroneScout Bridge') return;

      onDetection({
        mac,
        rssi,
        lastSeen: now,
        sourceMac: mac.toUpperCase(),
        sourceApiKey: NODE_API_KEYS[mac.toUpperCase()],
        ...parsed,
      });
    }
  );
}

export function stopBleScanning(): void {
  if (!scanning || !bleManager) return;
  bleManager.stopDeviceScan();
  scanning = false;
}

export function isBleScanning(): boolean {
  return scanning;
}

// --- Android background BLE scanning via foreground service ---

const BG_OPTIONS = {
  taskName: 'AirAware BLE Scanner',
  taskTitle: 'AirAware',
  taskDesc: 'Monitoring for drones',
  taskIcon: { name: 'ic_launcher', type: 'mipmap' },
  color: '#00E5FF',
  linkingURI: 'airaware://',
  parameters: { delay: 2_147_483_647 }, // ~25 days — effectively infinite
};

// Stash callbacks so the background task can access them
let bgOnDetection: ((det: Partial<OdidDetection> & { mac: string; rssi: number }) => void) | null = null;
let bgOnNearbyNode: ((mac: string, rssi: number, apiKey?: string) => void) | null = null;

async function bgTask(params: any): Promise<void> {
  // Start the actual BLE scan inside the foreground service
  if (bgOnDetection) {
    await startBleScanning(bgOnDetection, bgOnNearbyNode || undefined);
  }
  // Keep the task alive — sleep indefinitely so Android doesn't kill it.
  // BackgroundService.isRunning() becomes false when stopBackgroundScanning is called.
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!BackgroundService.isRunning()) {
        clearInterval(check);
        resolve();
      }
    }, 5000);
  });
}

export async function startBackgroundScanning(
  onDetection: (det: Partial<OdidDetection> & { mac: string; rssi: number }) => void,
  onNearbyNode?: (mac: string, rssi: number, apiKey?: string) => void,
): Promise<void> {
  if (Platform.OS !== 'android') {
    // iOS handles background BLE via CoreBluetooth background modes
    return startBleScanning(onDetection, onNearbyNode);
  }

  bgOnDetection = onDetection;
  bgOnNearbyNode = onNearbyNode || null;

  try {
    await BackgroundService.start(bgTask, BG_OPTIONS);
    console.log('[BG] Background BLE scanning started');
  } catch (err) {
    console.warn('[BG] Failed to start background service, falling back:', err);
    // Fall back to normal scanning if background service fails
    await startBleScanning(onDetection, onNearbyNode);
  }
}

export async function stopBackgroundScanning(): Promise<void> {
  stopBleScanning();
  if (Platform.OS === 'android' && BackgroundService.isRunning()) {
    await BackgroundService.stop();
    console.log('[BG] Background BLE scanning stopped');
  }
  bgOnDetection = null;
  bgOnNearbyNode = null;
}

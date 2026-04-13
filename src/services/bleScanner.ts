import { BleManager, Device, State } from 'react-native-ble-plx';
import { Platform } from 'react-native';
import { parseOdidAdvertisement, OdidDetection } from './odidParser';
import { useDroneStore } from '../store/droneStore';

const ODID_SERVICE_UUID = '0000FFFA-0000-1000-8000-00805F9B34FB';

// Hardcoded MAC → API key table for AirAware nodes.
// manufacturerData is null for extended BLE advertisements on Android,
// so we fall back to identifying nodes by MAC address + device name.
const NODE_API_KEYS: Record<string, string> = {
  '98:A3:16:7D:26:34': 'fe4e6448-e10e-45bf-b6b1-1b524bdfd173',
  '98:A3:16:7D:26:36': 'fe4e6448-e10e-45bf-b6b1-1b524bdfd173',
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

      // 1) AirAware node detection via device name + MAC lookup.
      //    manufacturerData is always null for extended advertisements on
      //    Android, so we identify nodes by their "AirAware-X1-*" name and
      //    resolve the API key from the hardcoded NODE_API_KEYS table.
      if (device.name && device.name.startsWith('AirAware-X1-')) {
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
            `[BLE] AirAware node ${device.name} (${macUpper}) has no API key in NODE_API_KEYS table`,
          );
          if (onNodeNearby) onNodeNearby(macUpper, rssi);
        }
        return;
      }

      // 2) Other broadcasts from an AirAware OUI MAC (Android, where
      //    device.id is the MAC). Attach the API key if we already know it.
      if (isAirAwareNode(mac)) {
        const macUpper = mac.toUpperCase();
        const known = discoveredNodes.get(macUpper);
        if (known) {
          known.rssi = rssi;
          known.lastSeen = now;
        }
        if (onNodeNearby) onNodeNearby(macUpper, rssi, known?.apiKey);
        return;
      }

      // 3) Parse ODID service data (third-party drone broadcasts)
      const serviceDataMap = device.serviceData;
      if (!serviceDataMap) return;

      const odidKey = Object.keys(serviceDataMap).find(k =>
        k.toLowerCase().includes('fffa')
      );
      if (!odidKey) return;

      const serviceData = serviceDataMap[odidKey];
      if (!serviceData) return;

      const parsed = parseOdidAdvertisement(mac, rssi, serviceData);
      if (!parsed) return;

      onDetection({
        mac,
        rssi,
        lastSeen: now,
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

import { BleManager, Device, State } from 'react-native-ble-plx';
import { Platform } from 'react-native';
import { Buffer } from 'buffer';
import { parseOdidAdvertisement, OdidDetection } from './odidParser';
import { useDroneStore } from '../store/droneStore';

const ODID_SERVICE_UUID = '0000FFFA-0000-1000-8000-00805F9B34FB';

// AirAware node OUI — skip relay broadcasts from our own nodes
const AIRAWARE_OUI = ['98:A3:16:7D', '98:a3:16:7d'];

// AirAware BLE manufacturer ID used for the identity advertisement
const AIRAWARE_COMPANY_ID = 0x08FE;

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

function formatMac(bytes: Buffer): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase();
}

// AirAware identity advertisement layout:
//   [company_id_LE (2 bytes)][mac (6 bytes)][api_key (remaining, UTF-8)]
function parseIdentityAdvertisement(
  manufacturerDataB64: string,
): { mac: string; apiKey: string } | null {
  try {
    const bytes = Buffer.from(manufacturerDataB64, 'base64');
    if (bytes.length < 8) return null;
    const companyId = bytes[0] | (bytes[1] << 8);
    if (companyId !== AIRAWARE_COMPANY_ID) return null;
    const mac = formatMac(bytes.slice(2, 8));
    const apiKey = bytes.slice(8).toString('utf8').replace(/\0+$/, '');
    if (!apiKey) return null;
    return { mac, apiKey };
  } catch {
    return null;
  }
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

      // 1) Identity advertisement (authoritative — gives us MAC + api key).
      //    On iOS device.id is a CoreBluetooth UUID, not a MAC, so the
      //    manufacturer payload is the only way to learn the real MAC.
      if (device.manufacturerData) {
        const identity = parseIdentityAdvertisement(device.manufacturerData);
        if (identity) {
          discoveredNodes.set(identity.mac, {
            mac: identity.mac,
            apiKey: identity.apiKey,
            rssi,
            lastSeen: now,
          });
          if (onNodeNearby) onNodeNearby(identity.mac, rssi, identity.apiKey);
          return;
        }
      }

      const mac = device.id;

      // 2) Relay/other broadcasts from an AirAware OUI (Android, where
      //    device.id is the MAC). Attach the api key if we already know it.
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

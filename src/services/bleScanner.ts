import { BleManager, Device, State } from 'react-native-ble-plx';
import { Platform } from 'react-native';
import { parseOdidAdvertisement, OdidDetection } from './odidParser';
import { useDroneStore } from '../store/droneStore';

const ODID_SERVICE_UUID = '0000FFFA-0000-1000-8000-00805F9B34FB';

// AirAware node OUI — skip relay broadcasts from our own nodes
const AIRAWARE_OUI = ['98:A3:16:7D', '98:a3:16:7d'];

let bleManager: BleManager | null = null;
let scanning = false;

function getBleManager(): BleManager {
  if (!bleManager) {
    bleManager = new BleManager();
  }
  return bleManager;
}

let onNodeNearby: ((mac: string, rssi: number) => void) | null = null;

function isAirAwareNode(mac: string): boolean {
  return mac.toUpperCase().startsWith('98:A3:16:7D');
}

export async function startBleScanning(
  onDetection: (det: Partial<OdidDetection> & { mac: string; rssi: number }) => void,
  onNearbyNode?: (mac: string, rssi: number) => void
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

      const mac = device.id;

      // Track nearby AirAware nodes for proximity indicator
      if (isAirAwareNode(mac)) {
        if (onNodeNearby) onNodeNearby(mac, device.rssi ?? -100);
        return;
      }

      // Parse ODID service data
      const serviceDataMap = device.serviceData;
      if (!serviceDataMap) return;

      const odidKey = Object.keys(serviceDataMap).find(k =>
        k.toLowerCase().includes('fffa')
      );
      if (!odidKey) return;

      const serviceData = serviceDataMap[odidKey];
      if (!serviceData) return;

      const parsed = parseOdidAdvertisement(mac, device.rssi ?? -100, serviceData);
      if (!parsed) return;

      onDetection({
        mac,
        rssi: device.rssi ?? -100,
        lastSeen: Date.now(),
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

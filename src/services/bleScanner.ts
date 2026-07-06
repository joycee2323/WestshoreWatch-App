import { NativeEventEmitter, Platform, EmitterSubscription, DeviceEventEmitter } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import NativeBLEScanner from '../specs/NativeBLEScanner';
import { parseOdidAdvertisement, OdidDetection } from './odidParser';
import { notifyNewDrone } from './droneNotifier';

export interface WatchdogStats {
  bleReinitCount: number;
  uploaderReinitCount: number;
  lastBleCallbackAgeMs: number | null;
  lastUploadSuccessAgeMs: number | null;
  scanning: boolean;
}

const BLEScanner = NativeBLEScanner as unknown as {
  startService: () => Promise<void>;
  stopService: () => Promise<void>;
  configure: (config: { baseUrl?: string; authToken?: string | null }) => Promise<void>;
  getWatchdogStats: () => Promise<WatchdogStats>;
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
};

if (Platform.OS === 'android' && !BLEScanner) {
  console.error(
    '[bleScanner] Native BLEScanner module not registered on Android. ' +
    'Verify the TurboModule is registered in the native binary. ' +
    'BLE scanning will not work until this is resolved.'
  );
}

const UPLOAD_BASE_URL = 'https://api.westshoredrone.com';

// TODO(follow-up): detection uploads from the Kotlin foreground service
// (DetectionUploader.kt) do NOT carry the X-Client-* diagnostic headers
// that services/api.ts injects on every JS-issued fetch. The native
// BLEScanner.configure() signature only accepts { baseUrl, authToken },
// so adding the headers requires either extending the native module's
// configure() schema or wiring a separate JS-managed header bag through
// the upload path. Detection uploads are also api-key auth'd (per-node
// X-Node-API-Key, see backend authenticateNode), not user-JWT auth'd,
// so they wouldn't move users.last_seen_at anyway — the missing
// headers would only be useful for future per-node device telemetry.
// Out of scope for the user-activity-tracking PR.

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
  // Rethrow so callers can surface BLE_SERVICE_NOT_RUNNING (the native side
  // verifies the service actually came up before resolving). A failure here
  // means scanning won't work — the user needs to know.
  await BLEScanner.startService();
  console.log('[BLE] Foreground service started successfully');
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
let reinitSubscription: EmitterSubscription | null = null;

// Native uploader emits this when its self-heal watchdog forces a stall
// reinit. We respond by re-pushing the current JWT, which resets the native
// authToken state and lets the next flush proceed.
//
// NB: This is "re-push the current token", not a real refresh. There's no
// /auth/refresh endpoint today (see DetectionUploader.kt's TODO). If the
// token has genuinely expired, this won't help — the next POST will 401 and
// the auth layer above will need to push the user back through login.
function attachUploaderReinitListener(): void {
  if (reinitSubscription) return;
  reinitSubscription = DeviceEventEmitter.addListener(
    'UploaderForcedReinit',
    async (payload: { reason?: string; queued?: number }) => {
      console.warn('[BLE] UploaderForcedReinit:', payload?.reason, 'queued=', payload?.queued);
      try {
        const token = await SecureStore.getItemAsync('auth_token');
        await configureNativeUpload(token);
      } catch (e) {
        console.warn('[BLE] failed to re-push token after UploaderForcedReinit:', e);
      }
    },
  );
}

export async function getWatchdogStats(): Promise<WatchdogStats | null> {
  if (Platform.OS !== 'android' || !BLEScanner?.getWatchdogStats) return null;
  try {
    return await BLEScanner.getWatchdogStats();
  } catch (e) {
    console.warn('[BLE] getWatchdogStats failed:', e);
    return null;
  }
}

export interface DiscoveredNode {
  mac: string;
  rssi: number;
  lastSeen: number;
}

const discoveredNodes = new Map<string, DiscoveredNode>();

// Firmware now emits basic_id every cycle (handle 0, option A) AND a
// self-identifying ODID Message Pack every cycle (handle 1, option C). TTL
// only needs to cover the ~50ms intra-burst gap between a basic_id and its
// sibling Location on the legacy path; 200ms gives ~4x headroom for BLE
// scanner batching/reorder jitter. Pack-parsed ads (msgType 0xF) bypass
// this inheritance path entirely — see below.
const ATTRIBUTION_TTL_MS = 200;
const ODID_MSG_PACK = 0xF;
const mergeBySource = new Map<string, { uasId: string; lastBasicIdAt: number }>();

export function getDiscoveredNodes(): Map<string, DiscoveredNode> {
  return discoveredNodes;
}

let onNodeNearby: ((mac: string, rssi: number) => void) | null = null;

// Identity advert (handle 3) company ID 0x08FE. Native packs it little-endian
// as the first two bytes of the manufacturerData blob (see BLEScannerService.kt
// emitScanResult: idBytes = [LSB, MSB]).
const WESTSHORE_COMPANY_ID_LSB = 0xFE;
const WESTSHORE_COMPANY_ID_MSB = 0x08;

function isWestshoreWatchNode(mac: string, manufacturerData: string | null): boolean {
  // Identity advert (handle 3): native packs [companyLSB, companyMSB, ...payload]
  // into manufacturerData (base64). Presence of the 0x08FE block IS the signal;
  // no gating on payload length beyond reading the 2-byte company id. Mirrors
  // the Kotlin isWestshoreWatchNode OR semantics. Do NOT match 0x08FF (that's
  // the detection advert, handle 2).
  if (manufacturerData) {
    try {
      // atob + charCodeAt for Hermes compatibility (matches odidParser.ts).
      const bin = atob(manufacturerData);
      if (
        bin.length >= 2 &&
        bin.charCodeAt(0) === WESTSHORE_COMPANY_ID_LSB &&
        bin.charCodeAt(1) === WESTSHORE_COMPANY_ID_MSB
      ) {
        return true;
      }
    } catch {
      // fall through to OUI check
    }
  }
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

    if (isWestshoreWatchNode(mac, device.manufacturerData)) {
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

    // Attribute the uasId. Three paths:
    //   (1) Pack (msgType 0xF): self-identifying, skip sourceMac attribution.
    //   (2) Legacy BasicId: refresh attribution for this sourceMac + TTL.
    //   (3) Legacy Location/System: inherit the most recent uasId on this
    //       sourceMac within the (tightened) TTL window.
    let effectiveUasId: string | undefined;
    if (parsed.msgType === ODID_MSG_PACK) {
      if (parsed.uasId) {
        effectiveUasId = parsed.uasId;
        const prev = mergeBySource.get(sourceMacUpper);
        // Still fire first-sighting notifications on pack arrivals, but DO
        // NOT write to mergeBySource — legacy-path inheritance state is
        // independent and shouldn't be influenced by pack emission.
        const isNewSighting = !prev || prev.uasId !== parsed.uasId;
        if (isNewSighting) void notifyNewDrone(parsed.uasId);
      }
    } else if (parsed.uasId) {
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
      // Pack-only mode: with self-identifying Pack frames (msgType 0xF) carrying
      // every drone's uasId in-band, the legacy source-MAC-based inheritance
      // fallback is no longer needed and was a known cause of two-drone position
      // swaps when BasicId arrival timing crossed between drones. If Pack
      // emission breaks at the firmware level (watch for ESP_LOGE lines from
      // ble_relay.c:286 and :292), drones will silently stop reporting until
      // Packs are restored.
      console.log(`[livemap] legacy frame dropped (Pack-only mode) sourceMac=${sourceMacUpper} lat=${parsed.lat} lon=${parsed.lon}`);
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
  attachUploaderReinitListener();
  await startForegroundService();
  scanning = true;
}

export function stopBleScanning(): void {
  if (!scanning) return;
  subscription?.remove();
  subscription = null;
  reinitSubscription?.remove();
  reinitSubscription = null;
  scanning = false;
  void stopForegroundService();
}

export function isBleScanning(): boolean {
  return scanning;
}

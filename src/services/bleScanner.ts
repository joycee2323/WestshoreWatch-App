import { NativeEventEmitter, Platform, EmitterSubscription, DeviceEventEmitter } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import NativeBLEScanner from '../specs/NativeBLEScanner';
import { parseOdidAdvertisement, OdidDetection } from './odidParser';
import { notifyNewDrone, resetNotifiedDrones } from './droneNotifier';
import { enqueueDetectionUpload, stopDetectionUpload } from './detectionUpload';

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

if (Platform.OS === 'ios' && !BLEScanner) {
  console.error(
    '[bleScanner] Native BLEScanner module not registered on iOS. ' +
    'BLE scanning, detection upload, and node heartbeat will not function. ' +
    'Verify the Swift BLEScanner module is compiled into the iOS bundle ' +
    '(see ios/BLEScannerModule and the expo config plugin).'
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
  if (!BLEScanner?.configure) return;
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
  if (!BLEScanner) return;
  // Rethrow so callers can surface BLE_SERVICE_NOT_RUNNING (the native side
  // verifies the service actually came up before resolving). A failure here
  // means scanning won't work — the user needs to know.
  await BLEScanner.startService();
  console.log('[BLE] Foreground service started successfully');
}

async function stopForegroundService(): Promise<void> {
  if (!BLEScanner) return;
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
  if (!BLEScanner?.getWatchdogStats) return null;
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

const ODID_MSG_PACK = 0xF;
const ODID_MSG_SYSTEM = 4;
// Westshore Watch node identity advertiser company ID (handle 3 in
// firmware/ble_relay.c, manufacturer-specific data [MAC(6)][api_key prefix]).
// A node is recognized by the presence of this company ID in its advert, not
// by MAC OUI alone — see isWestshoreWatchNode. The relay/pack adverts carry only
// ODID service data (0xFFFA) and the detection advert uses 0x08FF, so neither
// can match this check.
const WESTSHORE_COMPANY_ID = 0x08fe;

// Operator location (op_lat/op_lon) rides in the relayed System frame
// (ODID msgType 4), which — like Location — carries NO uasId. A System frame
// inherits its uasId through the SAME ambiguity gate as Location (exactly one
// live drone), then we cache its operator coords here keyed by that uasId. The
// position-bearing Location emit attaches them, so a System frame never emits a
// record on its own — it only enriches the Location-driven one with the pilot
// position. Reuses ATTRIBUTION_FRESHNESS_MS for staleness (System rotates ~1Hz
// like the others, so a Location emit is at most ~1s after the last System).
const operatorByUasId = new Map<string, { opLat: number; opLon: number; at: number }>();

// ── Cross-frame uasId inheritance for relayed single-message ODID ────────────
// A DroneScout bridge relays a DJI drone as standalone single messages —
// BasicId (carries uasId, no position), Location (carries position, no uasId),
// System (operator position, no uasId) — never a self-identifying Message Pack.
// So no single position-bearing frame carries a uasId, and Pack-only mode drops
// every one of them: no detection assembles. We reinstate inheritance, but
// GATED so it cannot reintroduce the two-drone position-swap bug Pack-only mode
// was created to fix.
//
// Binding key: the source (on iOS, the bridge's CBPeripheral.identifier surfaced
// as `mac`; on Android the bridge's device.address). All of a bridge's relayed
// frames — for every drone behind it — share this one key, so per-source scoping
// alone does NOT separate two drones. A standalone Location frame carries no
// per-drone key at all (the ASTM counter is a per-type rolling int, not an
// identity). Therefore we attribute ONLY when the source is relaying exactly one
// drone: we count distinct uasIds seen via BasicId within a wide window and
// inherit only when that count is 1. 0 or >=2 -> drop (never guess) — same
// outcome Pack-only gives today, so we are no worse with multiple drones and
// strictly better with one. The idle-node presence beacon is filtered out
// upstream (parsed.uasId?.startsWith('WSW-') returns early), so it never
// enters this set and never inflates the distinct-drone count.
//
// Per-source: distinct drone uasId -> last BasicId arrival time.
const recentBasicIdsBySource = new Map<string, Map<string, number>>();

// Distinct-drone detection window. Wide on purpose: the risk is asymmetric — a
// too-narrow window can miss a second drone's BasicId, false-positive
// "single drone", and swap; a too-wide window only costs recovered detections
// (drop when we could have attributed). So err wide.
const AMBIGUITY_WINDOW_MS = 3000;

// Max staleness of the sole inherited BasicId when pasting its uasId onto a
// position. Sized to the relay cadence: the DroneScout bridge rotates ODID
// message types and re-broadcasts BasicId only ~once per second, so Location
// frames routinely arrive 300-1800ms after the last BasicId. A 200ms bound
// (the old burst-arrival assumption) dropped nearly every Location; 2000ms
// matches the ~1Hz rotation. This does NOT affect swap safety — that lives
// entirely in the exactly-one-distinct-drone ambiguity gate above. The
// freshness bound only governs how stale a SINGLE drone's uasId may be between
// its own BasicId broadcasts, and with one candidate there is nothing to
// mismatch against.
const ATTRIBUTION_FRESHNESS_MS = 2000;

// Prune the source's BasicId set to the ambiguity window and return the live
// entries. Called fresh on every no-uasId frame — no latched "ambiguous" flag —
// so a second drone's BasicId stops attribution immediately (1->2 distinct) and
// its aging-out resumes attribution (2->1).
function liveBasicIds(sourceMacUpper: string, now: number): Map<string, number> {
  const perSource = recentBasicIdsBySource.get(sourceMacUpper);
  if (!perSource) return new Map();
  for (const [uasId, at] of perSource) {
    if (now - at > AMBIGUITY_WINDOW_MS) perSource.delete(uasId);
  }
  if (perSource.size === 0) recentBasicIdsBySource.delete(sourceMacUpper);
  return perSource;
}

export function getDiscoveredNodes(): Map<string, DiscoveredNode> {
  return discoveredNodes;
}

let onNodeNearby: ((mac: string, rssi: number) => void) | null = null;

// A Westshore node is recognized primarily by its company-0x08FE identity
// advert (the structural discovery signature the native scan filter already
// uses) — so any OUI (e.g. 10:BD:A3) is recognized. manufacturerData is base64
// of [companyId LE][payload]; we only need the first two bytes. Returns false
// for relay/pack frames (no manufacturer data) and detection frames (company
// 0x08FF), so it cannot match a relay advert. Falls back to the legacy MAC-OUI
// allowlist so pre-0x08FE fleet (98:A3:16:7D, 38:44:BE) still registers — this
// file is shared with Android, where the OUI-only path is load-bearing (6b369a66).
function isWestshoreWatchNode(mac: string, manufacturerData: string | null): boolean {
  if (manufacturerData) {
    try {
      // atob for Hermes compatibility — mirrors odidParser's service-data decode.
      const binary = atob(manufacturerData);
      if (
        binary.length >= 2 &&
        (binary.charCodeAt(0) | (binary.charCodeAt(1) << 8)) === WESTSHORE_COMPANY_ID
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

// The deployment this phone is relaying BLE detections to (iOS node-less path),
// or null = not relaying. Set by LiveMapScreen's relay-target reconciliation
// (see hooks/useRelayTarget): exactly one operable active deployment auto-picks,
// ambiguity prompts, nothing-operable clears. Guests / add-node never call this,
// so they never upload. Distinct from the map's VIEW scope — the phone is at one
// physical deployment and its detections belong to that one.
let relayDeploymentId: string | null = null;

export function setRelayDeployment(deploymentId: string | null): void {
  relayDeploymentId = deploymentId;
}

// ── Bridge-proximity badge ("NODE IN RANGE") ────────────────────────────────
// Per-node presence: a Westshore node's idle beacon (UAS_ID = "WSW-<device_id>",
// see firmware ble_relay.c encode_bridge_beacon()) is being received nearby.
// Tracked per device_id (a Map, not a single global flag) so this is
// genuinely node-specific — the prior version of this badge only knew "some
// bridge is near" from a third-party-compatibility "DroneScout Bridge" tag
// that carried no node identity at all; the "WSW-" prefix (and the device_id
// after it) is what replaces that. getBridgeInRange() stays a simple aggregate
// boolean (true if any node is in range) for the existing badge consumers
// (LiveMapScreen, GuestScanScreen, both of which just want a yes/no badge);
// getNodesInRange() exposes the actual per-node device_id list for anything
// that wants it. Each entry holds for BRIDGE_PROXIMITY_TTL_MS after its last
// beacon (longer than the ~1s rotation so it doesn't flicker), then is
// evicted. Surfaced via getBridgeInRange()/getNodesInRange() +
// 'BridgeInRangeChanged' events, mirroring the relay-target plumbing.
const BRIDGE_PROXIMITY_TTL_MS = 8000;
const nodesInRange = new Map<string, number>(); // device_id -> last-seen Date.now()
let bridgeProximityTimer: ReturnType<typeof setInterval> | null = null;

export function getBridgeInRange(): boolean {
  return nodesInRange.size > 0;
}

export function getNodesInRange(): string[] {
  return Array.from(nodesInRange.keys());
}

// Marked at/before the Part 1 'WSW-' idle-beacon filter — the beacon still
// returns there, so it never enters the inheritance path or the distinct-drone
// ambiguity count (that exclusion is load-bearing for swap protection).
function markNodeSeen(deviceId: string, now: number): void {
  const wasEmpty = nodesInRange.size === 0;
  nodesInRange.set(deviceId, now);
  if (wasEmpty) {
    DeviceEventEmitter.emit('BridgeInRangeChanged', { inRange: true });
  }
}

function startBridgeProximityTimer(): void {
  if (bridgeProximityTimer) return;
  bridgeProximityTimer = setInterval(() => {
    const now = Date.now();
    let evicted = false;
    for (const [deviceId, lastSeenAt] of nodesInRange) {
      if (now - lastSeenAt > BRIDGE_PROXIMITY_TTL_MS) {
        nodesInRange.delete(deviceId);
        evicted = true;
      }
    }
    if (evicted && nodesInRange.size === 0) {
      DeviceEventEmitter.emit('BridgeInRangeChanged', { inRange: false });
    }
  }, 1000);
}

function stopBridgeProximityTimer(): void {
  if (bridgeProximityTimer) {
    clearInterval(bridgeProximityTimer);
    bridgeProximityTimer = null;
  }
  const hadEntries = nodesInRange.size > 0;
  nodesInRange.clear();
  if (hadEntries) {
    DeviceEventEmitter.emit('BridgeInRangeChanged', { inRange: false });
  }
}

export async function startBleScanning(
  onDetection: (det: Partial<OdidDetection> & { mac: string; rssi: number; sourceMac?: string }) => void,
  onNearbyNode?: (mac: string, rssi: number) => void,
): Promise<void> {
  if (scanning) return;
  if (!BLEScanner) {
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

    // Recognized Westshore node (0x08FE identity advert or legacy OUI). Captured
    // once so the drone-notification upload gate below can reuse it: a recognized
    // node with a position is what drives the native upload path.
    const isNode = isWestshoreWatchNode(mac, device.manufacturerData);
    if (isNode) {
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

    if (parsed.uasId && parsed.uasId.startsWith('WSW-')) {
      // Idle-node presence beacon — UAS_ID = "WSW-<device_id>", this node's own
      // device_id (see firmware ble_relay.c encode_bridge_beacon()). The
      // "WSW-" prefix is unambiguous: no real drone's Remote ID UAS_ID will
      // ever start with it, replacing the old exact-match against a
      // third-party-compatibility "DroneScout Bridge" tag that carried no
      // node identity. STILL return unconditionally — this must never enter
      // the drone-detection / inheritance path or the distinct-drone
      // ambiguity count (Part 1's exclusion stays intact on both platforms).
      // Proximity badge is iOS-only, same as before — Android ships on its
      // own release train and keeps its existing OUI-MAC nearbyNodeCount path
      // untouched.
      if (Platform.OS === 'ios') {
        const deviceId = parsed.uasId.slice(4).toUpperCase();
        if (deviceId.length === 12) markNodeSeen(deviceId, now);
      }
      return;
    }

    // Legacy self-ID literal — current X1/M1 firmware still advertises this
    // exact UAS_ID for third-party Remote-ID-app compatibility (NOT a drone;
    // must stay as firmware ships it). Older than the "WSW-" prefix beacon
    // above, so it isn't caught by that check, and it carries no device_id to
    // recover. It MUST return here, before sourceMacUpper/attribution below:
    // a standalone BasicId frame has no lat/lon (parseBasicId sets neither),
    // so it can never itself become a position-bearing detection, but if left
    // to fall through it still gets recorded into recentBasicIdsBySource. A
    // same-source relayed Location/System frame with no in-frame uasId (e.g.
    // a DJI drone behind this bridge, real position, BasicId relay lagging
    // behind Location per the ~1Hz rotation noted below) can then inherit
    // this literal via the single-candidate ambiguity gate in liveBasicIds,
    // producing a real-position detection misattributed to "DroneScout
    // Bridge" instead of dropped or correctly attributed. Dropping it here
    // keeps it out of that inheritance pool entirely, matching how the
    // WSW- beacon above is excluded.
    if (parsed.uasId === 'DroneScout Bridge') {
      return;
    }

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
      }
    } else if (parsed.uasId) {
      effectiveUasId = parsed.uasId;
      // Record this drone's BasicId so a following no-uasId Location/System on
      // the same source can inherit it under the single-drone gate below.
      let perSource = recentBasicIdsBySource.get(sourceMacUpper);
      if (!perSource) {
        perSource = new Map();
        recentBasicIdsBySource.set(sourceMacUpper, perSource);
      }
      perSource.set(parsed.uasId, now);
    } else {
      // No in-frame uasId — a relayed standalone Location/System (e.g. a DJI
      // drone behind a DroneScout bridge). Inherit cross-frame ONLY when this
      // source is relaying exactly one drone in the ambiguity window; 0 or >=2
      // distinct drones -> drop, never guess. This preserves the Pack-only fix
      // against two-drone position swaps (with multiple drones we drop, exactly
      // as before) while recovering the single-drone case Pack-only lost.
      // Pack frames (msgType 0xF) never reach here — they self-identify above.
      const live = liveBasicIds(sourceMacUpper, now);
      if (live.size === 1) {
        const [soleUasId, basicIdAt] = [...live][0];
        if (now - basicIdAt <= ATTRIBUTION_FRESHNESS_MS) {
          effectiveUasId = soleUasId;
        } else {
          console.log(`[livemap] legacy frame dropped (single drone but BasicId stale ${now - basicIdAt}ms) sourceMac=${sourceMacUpper} lat=${parsed.lat} lon=${parsed.lon}`);
        }
      } else {
        // 0 drones (no BasicId yet) or >=2 drones (ambiguous): same drop
        // Pack-only mode performs today. If Pack emission breaks at the firmware
        // level (watch for ESP_LOGE lines from ble_relay.c:286 and :292),
        // single-drone relays still report via the inheritance branch above.
        console.log(`[livemap] legacy frame dropped (Pack-only mode, ${live.size} distinct drones) sourceMac=${sourceMacUpper} lat=${parsed.lat} lon=${parsed.lon}`);
      }
    }

    if (!effectiveUasId) return;

    // Cache operator coords from an attributable System frame, keyed by the
    // gated uasId. Same ambiguity gate as Location (effectiveUasId is only set
    // when exactly one drone is live), so no cross-drone operator mixups.
    if (
      parsed.msgType === ODID_MSG_SYSTEM &&
      typeof parsed.opLat === 'number' &&
      typeof parsed.opLon === 'number' &&
      !(parsed.opLat === 0 && parsed.opLon === 0)
    ) {
      operatorByUasId.set(effectiveUasId, { opLat: parsed.opLat, opLon: parsed.opLon, at: now });
    }

    // Resolve operator coords to attach: the frame's own (System) if present,
    // else the most recent cached coords for this uasId within the freshness
    // window — but only for a position-bearing (Location) emit, so a System
    // frame never produces a position-less detection on its own.
    let emitOpLat: number | undefined = parsed.opLat;
    let emitOpLon: number | undefined = parsed.opLon;
    const hasPosition =
      typeof parsed.lat === 'number' &&
      typeof parsed.lon === 'number' &&
      !(parsed.lat === 0 && parsed.lon === 0);
    if ((typeof emitOpLat !== 'number' || typeof emitOpLon !== 'number') && hasPosition) {
      const cachedOp = operatorByUasId.get(effectiveUasId);
      if (cachedOp && now - cachedOp.at <= ATTRIBUTION_FRESHNESS_MS) {
        emitOpLat = cachedOp.opLat;
        emitOpLon = cachedOp.opLon;
      }
    }

    onDetection({
      mac,
      rssi,
      lastSeen: now,
      sourceMac: sourceMacUpper,
      ...parsed,
      uasId: effectiveUasId,
      opLat: emitOpLat,
      opLon: emitOpLon,
    });

    // Android: uploads happen in Kotlin (DetectionUploader, keyed on node MAC)
    // so they survive Doze. iOS node-less relay: a DroneScout-bridge / DJI
    // detection has no Westshore node MAC, so the native uploader never gets it.
    // When this phone has a relay target set, push position-bearing detections
    // to the node-less upload path. No target -> no upload (map still works).
    //
    // isRecognizedNode uses the persistent discoveredNodes map rather than the
    // per-event isNode flag above: isNode is derived from THIS event's
    // manufacturerData, which is absent on ODID relay/detection adverts (they
    // carry only FFFA service data) — so it's false on exactly the events that
    // matter here. discoveredNodes accumulates across events for a given mac,
    // so it stays true once the node's 0x08FE identity advert has been seen.
    // Without this guard, a detection relayed through a recognized Westshore
    // node was ALSO posted here with node_id = NULL (see api.ts:
    // deploymentDetections), which is what left "Detected By" blank on iOS.
    const isRecognizedNode = discoveredNodes.has(sourceMacUpper);
    if (
      !isRecognizedNode &&
      relayDeploymentId &&
      typeof parsed.lat === 'number' &&
      typeof parsed.lon === 'number' &&
      !(parsed.lat === 0 && parsed.lon === 0)
    ) {
      enqueueDetectionUpload(relayDeploymentId, {
        id: effectiveUasId,
        lat: parsed.lat,
        lon: parsed.lon,
        alt: parsed.altGeo ?? null,
        spd: parsed.speedHoriz ?? null,
        hdg: parsed.heading ?? null,
        op_lat: emitOpLat ?? null,
        op_lon: emitOpLon ?? null,
        ts: parsed.odidTimestamp ?? null,
      });
    }

    // Local "new drone" fallback notification — arm ONLY when we actually
    // attempted to log this detection somewhere, so we never tell the user a
    // drone was detected that the backend has no record of. Two upload paths can
    // log it:
    //   • node-less JS upload (enqueueDetectionUpload above): relay target + position
    //   • native upload (iOS WSWDetectionUploader / Android DetectionUploader):
    //     fires for a recognized node with a position
    // If neither could have fired (no position, no relay target, not a node), do
    // NOT arm the fallback — in that case nothing will be logged and a "detected"
    // notification would be actively wrong. The legitimate backend-down case still
    // works: an upload WAS attempted, the push doesn't return, the 8s fallback
    // fires. notifyNewDrone dedups per-uasId, so calling it on every qualifying
    // frame still notifies at most once per drone per session.
    const nodeLessUploadAttempted = !isRecognizedNode && !!relayDeploymentId && hasPosition;
    const nativeUploadAttempted = isRecognizedNode && hasPosition;
    if (nodeLessUploadAttempted || nativeUploadAttempted) {
      void notifyNewDrone(effectiveUasId);
    }
  });

  // Prime the native uploader with the current token before scanning so the
  // first batch inside the service has what it needs to POST.
  const token = await SecureStore.getItemAsync('auth_token');
  await configureNativeUpload(token);
  attachUploaderReinitListener();
  await startForegroundService();
  startBridgeProximityTimer();
  scanning = true;
}

export function stopBleScanning(): void {
  if (!scanning) return;
  subscription?.remove();
  subscription = null;
  reinitSubscription?.remove();
  reinitSubscription = null;
  scanning = false;
  stopDetectionUpload();
  stopBridgeProximityTimer();
  // Clear the per-session seen-drones set + any pending fallback timers so the
  // next scan session (or the same drone after a genuine re-approach) can alert
  // again. Without this, notifiedUasIds never clears and a uasId seen once is
  // silently suppressed for the app's lifetime. Covers logout too: logout
  // unmounts LiveMapScreen, whose cleanup calls stopBleScanning.
  resetNotifiedDrones();
  void stopForegroundService();
}

export function isBleScanning(): boolean {
  return scanning;
}

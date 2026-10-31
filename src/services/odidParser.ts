// ODID BLE parser for React Native
// Parses ASTM F3411-22a Remote ID broadcasts from BLE advertisements
// Mirrors the ESP32 firmware's odid_decoder logic

const ODID_SERVICE_UUID = 'FFFA';
const ODID_APP_CODE = 0x0D;

export interface OdidDetection {
  mac: string;
  rssi: number;
  hasBasicId: boolean;
  hasLocation: boolean;
  hasSystem: boolean;
  msgType?: number; // 0=BasicId, 1=Location, 4=System, 0xF=MessagePack
  uasId?: string;
  lat?: number;
  lon?: number;
  altGeo?: number;
  speedHoriz?: number;
  heading?: number;
  status?: number; // 0=undeclared, 1=ground, 2=airborne, 3=emergency, 4=RID system failure (5-15 reserved → undefined)
  // Location bytes 17-18: height (m, raw * 0.5 - 1000) relative to heightType.
  // undefined = unknown/invalid.
  height?: number;
  // Location byte 1 bit 2: 0 = above takeoff, 1 = above ground. X1/M1 relays
  // always carry 0. Parsed for completeness; not uploaded.
  heightType?: number;
  // Location byte 4: signed vertical speed, raw * 0.5 m/s, positive up.
  // undefined = unknown/invalid.
  speedVert?: number;
  opLat?: number;
  opLon?: number;
  // ASTM F3411-22a Location message bytes 21-22 (uint16 LE): deciseconds
  // since the most recent UTC hour, range 0-36000. Drone-self-reported.
  // Used by the backend stale-frame gate to suppress phantom POSTs from
  // firmware cached re-broadcasts. Mirrors OdidParser.kt; the JS-side
  // parser doesn't feed the upload path (that's native via
  // BLEScannerService.kt + DetectionUploader.kt), but kept in parity so
  // any JS-side consumer has the same signal available.
  odidTimestamp?: number;
  // Relay format 2 (X1/M1 firmware >= 1.4-westshore, see RELAY_FORMAT_SPEC):
  // set ONLY when a Westshore relay Pack carried the drone's own ASTM Location
  // message. speedHoriz / heading then come from that spec message; every
  // other field still comes from the legacy message, exactly as before.
  // decoder / locRaw are uploaded so the backend marks speed/heading reliable;
  // absent = legacy decode (the backend keeps flagging it).
  decoder?: string;    // 'odid-spec-1'
  locRaw?: string;     // 50 lowercase hex chars: the drone's 25-byte Location message
  relayFormat?: number;
  lastSeen: number;
}

// Airborne status value from ODID spec
export const OP_STATUS_AIRBORNE = 2;

// ASTM F3411 / opendroneid invalid-or-unknown encodings → undefined, never a
// bogus number. Mirrors OdidParser.kt / WSWOdidParser.swift.
export const OP_STATUS_MAX_VALID = 4;    // 4 = RID system failure (F3411-22a); 5..15 reserved
export const ALT_INVALID_MAX_M = -999.75; // raw 0 = -1000 m (altitudes, height)
export const VSPEED_MAX_VALID_MPS = 62;   // 63 m/s = invalid

// Relay format 2 — WestshoreWatch-Firmware WSW-Firmware/main/odid_encoder.h
// (tag x1m1-1.4-westshore). The relay Pack's byte 1 is (rf << 5) | count;
// message 4 is the drone's own ASTM F3411 Location with its type nibble set to
// MSG_SPEC_LOCATION (0xE, reserved) so pre-1.2.5 apps skip it. rf is read from
// the Pack itself, never inferred: handle-0 per-message frames from the same
// relay stay in the legacy layout and are decoded the legacy way.
export const RELAY_FORMAT_SPEC = 2;
export const MSG_SPEC_LOCATION = 0xE;
export const DECODER_SPEC = 'odid-spec-1';

// ASTM F3411 / opendroneid Location bytes 1-4: byte 1 bit 0 SpeedMult, bit 1
// EWDirection; byte 2 = direction 0..179 (+180 with EW); >= 180 (opendroneid
// writes 361 as 181 + EW) = unknown; speed = mult ? raw*0.75 + 63.75 :
// raw*0.25, with raw 255 + mult = unknown (255 m/s). Lat/lon as doubles.
export function parseSpecLocationKinematics(msg: Uint8Array): {
  heading?: number; speedHoriz?: number; lat: number; lon: number;
} {
  const mult = msg[1] & 0x01;
  const ew = (msg[1] >> 1) & 0x01;
  const dir = msg[2];
  const raw = msg[3];
  const heading = dir >= 180 ? undefined : dir + (ew ? 180 : 0);
  const speedHoriz = mult && raw === 255 ? undefined : (mult ? raw * 0.75 + 63.75 : raw * 0.25);
  return { heading, speedHoriz, lat: readInt32LE(msg, 5) / 1e7, lon: readInt32LE(msg, 9) / 1e7 };
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

function readInt32LE(buf: Uint8Array, offset: number): number {
  return (buf[offset] | (buf[offset+1] << 8) | (buf[offset+2] << 16) | (buf[offset+3] << 24));
}

function readUInt16LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset+1] << 8);
}

function parseBasicId(msg: Uint8Array): Partial<OdidDetection> {
  const msgType = (msg[0] >> 4) & 0x0F;
  // Byte 0: msg type, Byte 1: ID type + UA type, Bytes 2-21: 20-byte UAS ID
  const idBytes = msg.slice(2, 22);
  let uasId = '';
  for (let i = 0; i < idBytes.length; i++) {
    if (idBytes[i] === 0) break;
    uasId += String.fromCharCode(idBytes[i]);
  }
  return { msgType, hasBasicId: true, uasId: uasId || undefined };
}

function parseLocation(msg: Uint8Array): Partial<OdidDetection> {
  const msgType = (msg[0] >> 4) & 0x0F;
  if (msg.length < 25) return { msgType };

  // Layout matches C6-Firmware ble_relay.c encode_location():
  //   [0] msg type | [1] status/ew_seg | [2] dir_mod/speed_mult | [3] speed | [4] vert_speed
  //   [5-8] lat | [9-12] lon | [13-14] alt_baro | [15-16] alt_geo | [17-18] height
  const statusRaw = (msg[1] >> 4) & 0x0F;
  const status = statusRaw <= OP_STATUS_MAX_VALID ? statusRaw : undefined;
  const heightType = (msg[1] >> 2) & 0x01;
  const vspeedRaw = msg[4] > 127 ? msg[4] - 256 : msg[4]; // signed int8
  const vspeed = vspeedRaw * 0.5;
  const speedVert = Math.abs(vspeed) <= VSPEED_MAX_VALID_MPS ? vspeed : undefined;
  const ewSeg = msg[1] & 0x01;
  const dirMod = (msg[2] >> 1) & 0x7F;
  const speedMult = msg[2] & 0x01;
  const speedRaw = msg[3];

  const latRaw = readInt32LE(msg, 5);
  const lonRaw = readInt32LE(msg, 9);
  const altGeoRaw = readUInt16LE(msg, 15);
  const heightRaw = readUInt16LE(msg, 17);
  const tsRaw = readUInt16LE(msg, 21);

  const lat = latRaw / 1e7;
  const lon = lonRaw / 1e7;
  const altGeoM = (altGeoRaw * 0.5) - 1000;
  const altGeo = altGeoM > ALT_INVALID_MAX_M ? altGeoM : undefined;
  const heightM = (heightRaw * 0.5) - 1000;
  const height = heightM > ALT_INVALID_MAX_M ? heightM : undefined;
  const speedHoriz = speedMult ? (speedRaw * 0.75 + 63.75) : (speedRaw * 0.25);
  const heading = dirMod + (ewSeg * 180);

  if (lat === 0 && lon === 0) return { msgType, hasLocation: false };

  return {
    msgType, hasLocation: true, lat, lon, altGeo, speedHoriz, heading, status,
    height, heightType, speedVert, odidTimestamp: tsRaw,
  };
}

function parseSystem(msg: Uint8Array): Partial<OdidDetection> {
  const msgType = (msg[0] >> 4) & 0x0F;
  if (msg.length < 25) return { msgType };
  const opLatRaw = readInt32LE(msg, 2);
  const opLonRaw = readInt32LE(msg, 6);
  const opLat = opLatRaw / 1e7;
  const opLon = opLonRaw / 1e7;
  if (opLat === 0 && opLon === 0) return { msgType, hasSystem: false };
  return { msgType, hasSystem: true, opLat, opLon };
}

// Parse a single ODID message (25 bytes)
function parseOdidMessage(msg: Uint8Array): Partial<OdidDetection> {
  const msgType = (msg[0] >> 4) & 0x0F;
  switch (msgType) {
    case 0: return parseBasicId(msg);
    case 1: return parseLocation(msg);
    case 4: return parseSystem(msg);
    case 0xF: return parsePack(msg); // Message pack
    default: return {};
  }
}

// Parse message pack (multiple messages in one advertisement)
function parsePack(data: Uint8Array): Partial<OdidDetection> {
  const msgType = (data[0] >> 4) & 0x0F; // 0xF for a pack
  if (data.length < 2) return { msgType };
  const msgCount = data[1] & 0x1F;
  const relayFormat = (data[1] >> 5) & 0x07;
  let result: Partial<OdidDetection> = {};
  let spec: Uint8Array | null = null;
  for (let i = 0; i < msgCount; i++) {
    const offset = 2 + i * 25;
    if (offset + 25 > data.length) break;
    const msg = data.slice(offset, offset + 25);
    if (((msg[0] >> 4) & 0x0F) === MSG_SPEC_LOCATION) { spec = msg; continue; }
    const parsed = parseOdidMessage(msg);
    result = { ...result, ...parsed };
  }
  // Relay format 2: speed / heading from the drone's own spec message, only
  // when the Pack says so AND a legacy Location was decoded alongside it.
  if (relayFormat === RELAY_FORMAT_SPEC && spec && result.hasLocation) {
    const k = parseSpecLocationKinematics(spec);
    const original = spec.slice();
    original[0] = (0x1 << 4) | (spec[0] & 0x0F);   // restore type 1 (Location)
    result = {
      ...result,
      speedHoriz: k.speedHoriz, heading: k.heading,
      decoder: DECODER_SPEC, locRaw: toHex(original), relayFormat,
    };
  }
  // Override sub-messages' msgType so the caller sees this was a pack.
  return { ...result, msgType };
}

// Find ODID service data in raw advertisement bytes
function findOdidPayload(data: Uint8Array): Uint8Array | null {
  let i = 0;
  while (i < data.length) {
    const len = data[i];
    if (len === 0 || i + len >= data.length) break;
    const type = data[i + 1];
    // Service Data - 16-bit UUID (type 0x16)
    if (type === 0x16 && len >= 3) {
      const uuid = (data[i + 3] << 8) | data[i + 2]; // LE
      if (uuid === 0xFFFA) {
        return data.slice(i + 2, i + 1 + len);
      }
    }
    i += len + 1;
  }
  return null;
}

// Main entry point — parse a BLE advertisement
export function parseOdidAdvertisement(
  mac: string,
  rssi: number,
  serviceData: string // hex string from react-native-ble-plx
): Partial<OdidDetection> | null {
  try {
    // Decode base64 service data from ble-plx (using atob for Hermes compatibility)
    const binary = atob(serviceData);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      data[i] = binary.charCodeAt(i);
    }

    // BLE ODID layout: [app_code 0x0D][counter][25-byte message]
    if (data.length < 27) return null;
    if (data[0] !== ODID_APP_CODE) return null;

    // Skip app code + counter
    const msg = data.slice(2);
    return parseOdidMessage(msg);
  } catch {
    return null;
  }
}

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
  status?: number; // 0=undeclared, 1=ground, 2=airborne, 3=emergency
  opLat?: number;
  opLon?: number;
  lastSeen: number;
}

// Airborne status value from ODID spec
export const OP_STATUS_AIRBORNE = 2;

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
  const status = (msg[1] >> 4) & 0x0F;
  const ewSeg = msg[1] & 0x01;
  const dirMod = (msg[2] >> 1) & 0x7F;
  const speedMult = msg[2] & 0x01;
  const speedRaw = msg[3];

  const latRaw = readInt32LE(msg, 5);
  const lonRaw = readInt32LE(msg, 9);
  const altGeoRaw = readUInt16LE(msg, 15);

  const lat = latRaw / 1e7;
  const lon = lonRaw / 1e7;
  const altGeo = (altGeoRaw * 0.5) - 1000;
  const speedHoriz = speedMult ? (speedRaw * 0.75 + 63.75) : (speedRaw * 0.25);
  const heading = dirMod + (ewSeg * 180);

  if (lat === 0 && lon === 0) return { msgType, hasLocation: false };

  return { msgType, hasLocation: true, lat, lon, altGeo, speedHoriz, heading, status };
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
  let result: Partial<OdidDetection> = {};
  for (let i = 0; i < msgCount; i++) {
    const offset = 2 + i * 25;
    if (offset + 25 > data.length) break;
    const msg = data.slice(offset, offset + 25);
    const parsed = parseOdidMessage(msg);
    result = { ...result, ...parsed };
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

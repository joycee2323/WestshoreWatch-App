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
  // Bytes 1-20: UAS ID (null-terminated string or bytes)
  const idBytes = msg.slice(1, 21);
  let uasId = '';
  for (let i = 0; i < idBytes.length; i++) {
    if (idBytes[i] === 0) break;
    uasId += String.fromCharCode(idBytes[i]);
  }
  return { hasBasicId: true, uasId: uasId || undefined };
}

function parseLocation(msg: Uint8Array): Partial<OdidDetection> {
  if (msg.length < 25) return {};
  const status = (msg[1] >> 4) & 0x0F;
  const latRaw = readInt32LE(msg, 4);
  const lonRaw = readInt32LE(msg, 8);
  const altGeoRaw = readUInt16LE(msg, 12);
  const speedRaw = msg[20];
  const headingRaw = readUInt16LE(msg, 16);

  const lat = latRaw / 1e7;
  const lon = lonRaw / 1e7;
  const altGeo = (altGeoRaw * 0.5) - 1000;
  const speedHoriz = speedRaw * 0.25;
  const heading = headingRaw * 0.01;

  if (lat === 0 && lon === 0) return { hasLocation: false };

  return { hasLocation: true, lat, lon, altGeo, speedHoriz, heading, status };
}

function parseSystem(msg: Uint8Array): Partial<OdidDetection> {
  if (msg.length < 25) return {};
  const opLatRaw = readInt32LE(msg, 2);
  const opLonRaw = readInt32LE(msg, 6);
  const opLat = opLatRaw / 1e7;
  const opLon = opLonRaw / 1e7;
  if (opLat === 0 && opLon === 0) return { hasSystem: false };
  return { hasSystem: true, opLat, opLon };
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
  if (data.length < 2) return {};
  const msgCount = data[1] & 0x1F;
  let result: Partial<OdidDetection> = {};
  for (let i = 0; i < msgCount; i++) {
    const offset = 2 + i * 25;
    if (offset + 25 > data.length) break;
    const msg = data.slice(offset, offset + 25);
    const parsed = parseOdidMessage(msg);
    result = { ...result, ...parsed };
  }
  return result;
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
    // Decode base64 service data from ble-plx
    const bytes = Buffer.from(serviceData, 'base64');
    const data = new Uint8Array(bytes);

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

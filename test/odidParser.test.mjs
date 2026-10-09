import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOdidAdvertisement } from '../src/services/odidParser.ts';

// Run with: node --test test/*.test.mjs   (Node 22.18+ / 24 strips the .ts types).
// Deliberately NOT a package.json script: @expo/fingerprint hashes
// packageJson:scripts, so adding one would change the runtime fingerprint.
//
// The SAME cases run against OdidParser.kt in
// android/app/src/test/java/com/westshoredrone/watch/OdidParserTest.kt, so the
// two parsers cannot drift. Keep the case lists identical. (WSWOdidParser.swift
// has no test target; it mirrors the Kotlin code line for line.)

// Build one 25-byte Location message (X1/M1 relay byte layout for bytes 1-3;
// status, vertical speed and height sit at the same positions in every layout).
function location({
  status = 1, heightType = 0, b1low = 0, dir = 0, speedRaw = 0, vspeedRaw = 0,
  latE7 = 414611922, lonE7 = -819237012, geoRaw = 2358, heightRaw = 1998, ts = 1234,
} = {}) {
  const m = new Uint8Array(25);
  const dv = new DataView(m.buffer);
  m[0] = 0x12; // type 1 (Location), protocol version 2
  m[1] = (status << 4) | (heightType << 2) | b1low;
  m[2] = dir;
  m[3] = speedRaw;
  m[4] = vspeedRaw & 0xFF;
  dv.setInt32(5, latE7, true);
  dv.setInt32(9, lonE7, true);
  dv.setUint16(13, geoRaw, true); // baro
  dv.setUint16(15, geoRaw, true); // geodetic
  dv.setUint16(17, heightRaw, true);
  dv.setUint16(21, ts, true);
  return m;
}
function basicId(uasId) {
  const m = new Uint8Array(25);
  m[0] = 0x02;
  m[1] = 0x12;
  for (let i = 0; i < uasId.length; i++) m[2 + i] = uasId.charCodeAt(i);
  return m;
}
function serviceData(msg) {
  const d = new Uint8Array(2 + msg.length);
  d[0] = 0x0D; d[1] = 7; d.set(msg, 2);
  return Buffer.from(d).toString('base64');
}
function pack(...msgs) {
  const p = new Uint8Array(2 + 25 * msgs.length);
  p[0] = 0xF2; p[1] = msgs.length;
  msgs.forEach((m, i) => p.set(m, 2 + 25 * i));
  return p;
}
const parse = msg => parseOdidAdvertisement('AA:BB:CC:DD:EE:FF', -60, serviceData(msg));

// [name, Location fields, expected { status, height, heightType, speedVert, altGeo }]
// null = unknown/invalid (undefined in TS, null in Kotlin).
const CASES = [
  ['decoded docked Skydio frame', {}, { status: 1, height: -1, heightType: 0, speedVert: 0, altGeo: 179 }],
  ['height raw 0 (-1000 m) is invalid', { heightRaw: 0 }, { height: null }],
  ['geodetic altitude raw 0 (-1000 m) is invalid', { geoRaw: 0 }, { altGeo: null }],
  ['height raw 1 (-999.5 m) is a value', { heightRaw: 1 }, { height: -999.5 }],
  ['height 30 m', { heightRaw: 2060 }, { height: 30 }],
  ['vertical speed 63 m/s is invalid', { vspeedRaw: 126 }, { speedVert: null }],
  ['vertical speed -63 m/s is invalid', { vspeedRaw: -126 }, { speedVert: null }],
  ['vertical speed 63.5 m/s (raw 127) is invalid', { vspeedRaw: 127 }, { speedVert: null }],
  ['vertical speed -64 m/s (raw -128) is invalid', { vspeedRaw: -128 }, { speedVert: null }],
  ['vertical speed +62 m/s is the max valid', { vspeedRaw: 124 }, { speedVert: 62 }],
  ['vertical speed -1.5 m/s (descending)', { vspeedRaw: -3 }, { speedVert: -1.5 }],
  ['status 0 (undeclared)', { status: 0 }, { status: 0 }],
  ['status 2 (airborne)', { status: 2 }, { status: 2 }],
  ['status 3 (emergency)', { status: 3 }, { status: 3 }],
  ['status 5 (reserved) is unknown', { status: 5 }, { status: null }],
  ['status 15 (reserved) is unknown', { status: 15 }, { status: null }],
  ['height type 1 (above ground) does not disturb status', { heightType: 1 }, { status: 1, heightType: 1 }],
];

for (const [name, fields, expected] of CASES) {
  test(`Location: ${name}`, () => {
    const r = parse(location(fields));
    assert.equal(r.hasLocation, true);
    for (const [k, v] of Object.entries(expected)) {
      if (v === null) assert.equal(r[k], undefined, `${k} should be unknown`);
      else assert.equal(r[k], v, k);
    }
  });
}

test('Skydio frame: position, speed and timestamp unchanged', () => {
  const r = parse(location());
  assert.equal(r.lat, 41.4611922);
  assert.equal(r.lon, -81.9237012);
  assert.equal(r.speedHoriz, 0);
  assert.equal(r.odidTimestamp, 1234);
});

test('existing horizontal speed / heading decoding is unchanged', () => {
  // X1/M1 relay layout: byte 1 bit 0 = E/W segment, byte 2 = direction<<1 | multiplier.
  const r = parse(location({ b1low: 1, dir: (45 << 1) | 0, speedRaw: 20 }));
  assert.equal(r.heading, 225);
  assert.equal(r.speedHoriz, 5);
  const fast = parse(location({ dir: (10 << 1) | 1, speedRaw: 4 }));
  assert.equal(fast.heading, 10);
  assert.equal(fast.speedHoriz, 4 * 0.75 + 63.75);
});

test('Pack (BasicID + Location) carries status, height and vertical speed', () => {
  const r = parse(pack(basicId('1668BR40FA0098ER'), location({ vspeedRaw: 1 })));
  assert.equal(r.msgType, 0xF);
  assert.equal(r.uasId, '1668BR40FA0098ER');
  assert.equal(r.status, 1);
  assert.equal(r.height, -1);
  assert.equal(r.speedVert, 0.5);
});

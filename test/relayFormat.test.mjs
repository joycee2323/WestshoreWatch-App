import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOdidAdvertisement, DECODER_SPEC } from '../src/services/odidParser.ts';
import { uploadBody } from '../src/services/uploadPayload.ts';
import { isOnGroundFrame } from '../src/services/onGround.ts';

// Relay format 2 (X1/M1 firmware >= 1.4-westshore). Vectors generated from the
// real firmware code — see test/vectors/README.md. The same file is read by
// OdidParserTest.kt so TS and Kotlin decode identical bytes identically.
//
// Run with: node --test test/*.test.mjs

const lines = readFileSync(new URL('./vectors/relay_format_2_vectors.txt', import.meta.url), 'utf8')
  .trim().split('\n');
const V = lines.map(l => {
  const [name, legacy, rf2, droneLoc, hdg, spd, status, height, lat, lon] = l.trim().split(';');
  return {
    name, legacy, rf2, droneLoc,
    hdg: hdg === '-' ? undefined : Number(hdg), spd: spd === '-' ? undefined : Number(spd),
    status: Number(status), height: Number(height), lat: Number(lat), lon: Number(lon),
  };
});
const sd = hex => Buffer.concat([Buffer.from([0x0D, 0x07]), Buffer.from(hex, 'hex')]).toString('base64');
const parse = hex => parseOdidAdvertisement('AA:BB:CC:DD:EE:FF', -60, sd(hex));

// The fields the shipped (1.2.4) path takes from the legacy message.
const LEGACY_FIELDS = ['uasId', 'lat', 'lon', 'altGeo', 'status', 'height', 'heightType', 'speedVert',
  'odidTimestamp', 'opLat', 'opLon', 'hasLocation', 'hasSystem', 'hasBasicId', 'msgType'];

test('vectors file: 310 cases from x1m1-1.4-westshore', () => {
  assert.equal(V.length, 310);
  assert.ok(V.every(v => v.legacy.length === 154 && v.rf2.length === 204 && v.droneLoc.length === 50));
});

for (const v of V) {
  test(`relay vectors: ${v.name}`, () => {
    const old = parse(v.legacy);
    const neu = parse(v.rf2);
    assert.ok(old && neu);

    // 1.3 relay Pack: exactly the 1.2.4 decode — no spec claim, no decoder.
    assert.equal(old.decoder, undefined);
    assert.equal(old.locRaw, undefined);
    assert.equal(old.relayFormat, undefined);

    // 1.4 relay Pack: legacy-message fields identical to the 1.3 decode ...
    for (const k of LEGACY_FIELDS) assert.deepEqual(neu[k], old[k], `${k} must match the 1.3 decode`);

    // ... and speed / heading from the drone's own spec message.
    assert.equal(neu.decoder, DECODER_SPEC);
    assert.equal(neu.relayFormat, 2);
    assert.equal(neu.locRaw, v.droneLoc);
    if (v.hdg === undefined) assert.equal(neu.heading, undefined, 'unknown heading (361)');
    else assert.ok(Math.abs(neu.heading - v.hdg) < 0.01, `heading ${neu.heading} vs ${v.hdg}`);
    if (v.spd === undefined) assert.equal(neu.speedHoriz, undefined, 'unknown speed (255)');
    else assert.ok(Math.abs(neu.speedHoriz - v.spd) < 0.006, `speed ${neu.speedHoriz} vs ${v.spd}`);

    // Status: 0-4 valid, 5-15 unknown (both Packs carry the drone's status).
    assert.equal(neu.status, v.status <= 4 ? v.status : undefined);
    // Lat/lon from the legacy message keep the 1.3 relay's float32 rounding (<~2 m).
    assert.ok(Math.abs(neu.lat - v.lat) < 2e-5 && Math.abs(neu.lon - v.lon) < 2e-5, 'position');
    assert.ok(Math.abs(neu.height - v.height) <= 0.5 || neu.height === undefined, 'height');

    // Upload bodies: legacy = the 1.2.4 body (no decoder keys); rf=2 adds both.
    const rec = p => ({ id: p.uasId, lat: p.lat, lon: p.lon, spd: p.speedHoriz, hdg: p.heading,
      status: p.status, decoder: p.decoder, loc_raw: p.locRaw });
    const ob = uploadBody(rec(old)), nb = uploadBody(rec(neu));
    assert.equal('decoder' in ob, false);
    assert.equal('loc_raw' in ob, false);
    assert.equal(nb.decoder, 'odid-spec-1');
    assert.match(nb.loc_raw, /^1[0-9a-f]{49}$/);

    // Grounded invariant: only status 1 can ever be on-ground.
    if (neu.status !== 1) assert.equal(isOnGroundFrame(neu), false);
  });
}

test('rf bits without the 0xE message never claim spec decode', () => {
  const v = V.find(x => x.name === 'airborne_dir271_spd10');
  const b = Buffer.from(v.rf2, 'hex');
  b[1] = (2 << 5) | 3;                       // rf=2 but only 3 messages: no spec message read
  const r = parse(b.toString('hex'));
  assert.equal(r.decoder, undefined);
  assert.equal(r.heading, parse(v.legacy).heading);
});

test('a 0xE message without rf=2 bits is ignored', () => {
  const v = V.find(x => x.name === 'airborne_dir271_spd10');
  const b = Buffer.from(v.rf2, 'hex');
  b[1] = 4;                                  // rf=0, count 4
  const r = parse(b.toString('hex'));
  assert.equal(r.decoder, undefined);
  assert.equal(r.heading, parse(v.legacy).heading);
});

test('headline case: dir 271 / 10 m/s — 1.2.4 shows 45 deg / 30 m/s, 1.2.5 shows 271 / 10', () => {
  const v = V.find(x => x.name === 'airborne_dir271_spd10');
  assert.equal(parse(v.legacy).heading, 45);
  assert.equal(parse(v.legacy).speedHoriz, 30);
  assert.equal(parse(v.rf2).heading, 271);
  assert.equal(parse(v.rf2).speedHoriz, 10);
});

test('grounded invariant: every status other than 1 is never on ground', () => {
  for (let s = 0; s <= 15; s++) {
    const g = isOnGroundFrame({ status: s, speedHoriz: 0, height: 0 });
    assert.equal(g, s === 1, `status ${s}`);
  }
});

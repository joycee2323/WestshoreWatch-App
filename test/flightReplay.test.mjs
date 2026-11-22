import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normTs, buildReplay, toRealTime, toProgress, windowIndexAt, frameAt,
  trailUpTo, fullTrail, boundsOf, fmtElapsed, autoSpeedIndex,
  MERGE_GAP_MS, MIN_WINDOW_MS, HOLD_GAP_MS,
} from '../src/services/flightReplay.ts';

// Run with: node --test test/*.test.mjs   (not a package.json script — see fmtAgl.test.mjs).

const T0 = Date.parse('2026-11-01T15:00:00Z');
const sec = (s) => T0 + s * 1000;

// A drone flying north from (49, -123), one point per `step` seconds.
function row(uas, startS, n, step = 1, extra = {}) {
  return {
    uas_id: uas,
    path: Array.from({ length: n }, (_, i) => ({
      lat: 49 + i * 0.0001, lon: -123, ts: new Date(sec(startS + i * step)).toISOString(),
    })),
    ...extra,
  };
}

test('normTs accepts epoch ms, epoch seconds, numeric strings, ISO and Date', () => {
  assert.equal(normTs(T0), T0);
  assert.equal(normTs(T0 / 1000), T0);
  assert.equal(normTs(String(T0)), T0);
  assert.equal(normTs(String(T0 / 1000)), T0);
  assert.equal(normTs('2026-11-01T15:00:00Z'), T0);
  assert.equal(normTs('2026-11-01T15:00:00.000+00:00'), T0);
  assert.equal(normTs(new Date(T0)), T0);
  assert.equal(normTs(1762009200.5), 1762009200500); // fractional seconds
  for (const bad of [null, undefined, '', 'not a date', 0, -5, NaN, {}]) {
    assert.equal(normTs(bad), null, `normTs(${String(bad)})`);
  }
});

test('buildReplay drops bad points, coerces strings and sorts by time', () => {
  const r = buildReplay([{
    uas_id: 'A',
    path: [
      { lat: '49.0002', lon: '-123', ts: sec(2) },          // strings + epoch ms
      { lat: 49.0001, lon: -123, ts: (sec(1)) / 1000 },     // epoch seconds
      { lat: 0, lon: 0, ts: sec(3) },                       // no-fix
      { lat: 95, lon: -123, ts: sec(4) },                   // out of range
      { lat: 49, lon: 181, ts: sec(5) },                    // out of range
      { lat: 49, lon: -123, ts: 'garbage' },                // bad ts
      { lat: null, lon: -123, ts: sec(6) },                 // missing
      { lat: 49.0000, lon: -123, ts: new Date(sec(0)).toISOString() },
    ],
  }, null, 'junk', { uas_id: 'EMPTY', path: [] }]);
  assert.equal(r.drones.length, 1);
  const d = r.drones[0];
  assert.deepEqual(d.points.map(p => p.t), [sec(0), sec(1), sec(2)]);
  assert.equal(d.points[2].lat, 49.0002);
  assert.equal(d.start, sec(0));
  assert.equal(d.end, sec(2));
});

test('no path falls back to last_lat/last_lon/last_seen as one point', () => {
  const r = buildReplay([{
    uas_id: 'B', path: null, last_lat: '49.5', last_lon: '-123.5', last_seen: new Date(sec(10)).toISOString(),
    alt_agl_m: '30', op_lat: '49.4', op_lon: '-123.4', nickname: 'Bravo', model: 'Mavic 3',
  }]);
  assert.equal(r.drones.length, 1);
  const d = r.drones[0];
  assert.deepEqual(d.points, [{ t: sec(10), lat: 49.5, lon: -123.5, agl: 30, spd: null }]);
  assert.equal(d.name, 'Bravo');
  assert.equal(d.model, 'Mavic 3');
  assert.deepEqual(d.pilot, [-123.4, 49.4]);
  // Single point still gets a minimum-length window.
  assert.equal(r.activeMs, MIN_WINDOW_MS);
});

test('nickname map wins over row nickname; op 0,0 is not a pilot', () => {
  const r = buildReplay([row('C', 0, 2, 1, { nickname: 'Row', op_lat: 0, op_lon: 0 })], { C: 'Map' });
  assert.equal(r.drones[0].name, 'Map');
  assert.equal(r.drones[0].pilot, null);
});

test('rows with the same uas_id merge into one drone', () => {
  const r = buildReplay([row('D', 0, 3), row('D', 3, 3)]);
  assert.equal(r.drones.length, 1);
  assert.equal(r.drones[0].points.length, 6);
});

test('window merge: gap at the threshold merges, just over splits', () => {
  const gapS = MERGE_GAP_MS / 1000;
  // A: 0..10 s. B starts exactly 90 s after A ends → one window.
  let r = buildReplay([row('A', 0, 11), row('B', 10 + gapS, 11)]);
  assert.equal(r.windows.length, 1);
  assert.equal(r.activeMs, (20 + gapS) * 1000);
  // 91 s gap → two windows; idle time is skipped.
  r = buildReplay([row('A', 0, 11), row('B', 11 + gapS, 11)]);
  assert.equal(r.windows.length, 2);
  assert.equal(r.activeMs, 20_000);
  assert.equal(r.windows[1].offset, 10_000);
  assert.equal(r.start, sec(0));
  assert.equal(r.end, sec(21 + gapS));
});

test("one drone's own long gap splits it into two windows", () => {
  const r = buildReplay([{
    uas_id: 'E',
    path: [...row('E', 0, 11).path, ...row('E', 3 * 3600, 11).path],
  }]);
  assert.equal(r.windows.length, 2);
  assert.equal(r.activeMs, 20_000);
});

test('progress ↔ real time round trip and gap handling', () => {
  const r = buildReplay([row('A', 0, 11), row('B', 1000, 21)]);
  const w = r.windows;
  assert.equal(w.length, 2);
  assert.equal(r.activeMs, 30_000);
  for (const p of [0, 1, 5_000, 9_999, 10_000, 15_000, 29_999, 30_000]) {
    assert.equal(toProgress(w, toRealTime(w, p)), p, `progress ${p}`);
  }
  assert.equal(toRealTime(w, 10_000), sec(1000));     // second window start
  assert.equal(toRealTime(w, 99_999), sec(1020));     // clamped to end
  assert.equal(toRealTime(w, -5), sec(0));            // clamped to start
  assert.equal(toProgress(w, sec(500)), 10_000);      // inside gap → next window
  assert.equal(toProgress(w, sec(-50)), 0);
  assert.equal(toProgress(w, sec(5000)), 30_000);
  assert.equal(windowIndexAt(w, 0), 0);
  assert.equal(windowIndexAt(w, 9_999), 0);
  assert.equal(windowIndexAt(w, 10_000), 1);
  assert.equal(windowIndexAt([], 0), -1);
});

test('frameAt interpolates position, speed, bearing and AGL', () => {
  const r = buildReplay([{
    uas_id: 'F', alt_agl_m: 50, last_altitude: 150,
    path: [
      { lat: 49, lon: -123, alt: 100, ts: sec(0) },
      { lat: 49.001, lon: -123, alt: 150, ts: sec(10) },
    ],
  }]);
  const d = r.drones[0];
  assert.equal(frameAt(d, sec(-1)).state, 'pending');
  const f = frameAt(d, sec(5));
  assert.equal(f.state, 'flying');
  assert.equal(f.holding, false);
  assert.ok(Math.abs(f.lat - 49.0005) < 1e-9);
  assert.equal(f.lon, -123);
  assert.ok(Math.abs(f.bearing) < 1e-6 || Math.abs(f.bearing - 360) < 1e-6, `north, got ${f.bearing}`);
  // 0.001° lat ≈ 111.2 m in 10 s.
  assert.ok(Math.abs(f.speed - 11.12) < 0.05, `speed ${f.speed}`);
  // Point AGL = alt + (alt_agl_m - last_altitude): 0 m then 50 m.
  assert.equal(d.points[0].agl, 0);
  assert.equal(d.points[1].agl, 50);
  assert.equal(f.agl, 25);
  const done = frameAt(d, sec(11));
  assert.equal(done.state, 'done');
  assert.equal(done.lat, 49.001);
});

test('per-point alt_agl_m and spd win when present', () => {
  const d = buildReplay([{
    uas_id: 'G',
    path: [
      { lat: 49, lon: -123, ts: sec(0), alt_agl_m: 10, spd: 4 },
      { lat: 49.001, lon: -123, ts: sec(10), alt_agl_m: 30, spd: 8 },
    ],
  }]).drones[0];
  const f = frameAt(d, sec(5));
  assert.equal(f.agl, 20);
  assert.equal(f.speed, 6);
});

test('frameAt holds position across gaps longer than HOLD_GAP_MS', () => {
  const holdS = HOLD_GAP_MS / 1000;
  const d = buildReplay([{
    uas_id: 'H',
    path: [
      { lat: 49, lon: -123, ts: sec(0) },
      { lat: 49.01, lon: -123, ts: sec(holdS + 1) },
    ],
  }]).drones[0];
  const f = frameAt(d, sec(60));
  assert.equal(f.holding, true);
  assert.equal(f.lat, 49);
  // At exactly the threshold it still interpolates.
  const d2 = buildReplay([{
    uas_id: 'H2',
    path: [
      { lat: 49, lon: -123, ts: sec(0) },
      { lat: 49.01, lon: -123, ts: sec(holdS) },
    ],
  }]).drones[0];
  const f2 = frameAt(d2, sec(holdS / 2));
  assert.equal(f2.holding, false);
  assert.ok(Math.abs(f2.lat - 49.005) < 1e-9);
});

test('trails: progress trail ends at the playhead; long gaps break the line', () => {
  const holdS = HOLD_GAP_MS / 1000;
  const d = buildReplay([{
    uas_id: 'T',
    path: [
      { lat: 49, lon: -123, ts: sec(0) },
      { lat: 49.001, lon: -123, ts: sec(10) },
      { lat: 49.002, lon: -123, ts: sec(20) },
      { lat: 49.1, lon: -123, ts: sec(20 + holdS + 1) },
      { lat: 49.101, lon: -123, ts: sec(30 + holdS + 1) },
    ],
  }]).drones[0];
  assert.equal(fullTrail(d).length, 2);
  assert.deepEqual(trailUpTo(d, sec(-1)), []);
  const t = trailUpTo(d, sec(15));
  assert.equal(t.length, 1);
  assert.equal(t[0].length, 3);
  assert.ok(Math.abs(t[0][2][1] - 49.0015) < 1e-9);
  // While holding in the gap no line is drawn toward the next fix.
  const hold = trailUpTo(d, sec(60));
  assert.equal(hold.length, 1);
  assert.deepEqual(hold[0][hold[0].length - 1], [-123, 49.002]);
});

test('boundsOf includes pilot positions; single point gives zero-size bounds', () => {
  const r = buildReplay([
    row('A', 0, 3, 1, { op_lat: 48.9, op_lon: -123.2 }),
    { uas_id: 'S', last_lat: 49.3, last_lon: -122.9, last_seen: sec(1) },
  ]);
  assert.deepEqual(boundsOf(r.drones), { minLat: 48.9, maxLat: 49.3, minLon: -123.2, maxLon: -122.9 });
  const one = buildReplay([{ uas_id: 'S', last_lat: 49.3, last_lon: -122.9, last_seen: sec(1) }]);
  assert.deepEqual(boundsOf(one.drones), { minLat: 49.3, maxLat: 49.3, minLon: -122.9, maxLon: -122.9 });
  assert.equal(boundsOf([]), null);
});

test('empty input', () => {
  const r = buildReplay([]);
  assert.deepEqual(r, { drones: [], windows: [], start: 0, end: 0, activeMs: 0 });
  assert.equal(toRealTime(r.windows, 100), 0);
  assert.equal(toProgress(r.windows, 100), 0);
});

test('fmtElapsed', () => {
  assert.equal(fmtElapsed(0), '0:00');
  assert.equal(fmtElapsed(999), '0:00');
  assert.equal(fmtElapsed(61_000), '1:01');
  assert.equal(fmtElapsed(59 * 60_000 + 59_999), '59:59');
  assert.equal(fmtElapsed(3_600_000), '1:00:00');
  assert.equal(fmtElapsed(3 * 3_600_000 + 5 * 60_000 + 7_000), '3:05:07');
  assert.equal(fmtElapsed(-5), '0:00');
  assert.equal(fmtElapsed(NaN), '0:00');
});

test('autoSpeedIndex picks the slowest speed fitting ~40 s', () => {
  assert.equal(autoSpeedIndex(30_000), 0);          // 1x
  assert.equal(autoSpeedIndex(40_000), 0);
  assert.equal(autoSpeedIndex(5 * 60_000), 2);      // 300 s / 10 = 30 s
  assert.equal(autoSpeedIndex(20 * 60_000), 3);     // 1200 s / 30 = 40 s
  assert.equal(autoSpeedIndex(10 * 3_600_000), 6);  // capped at 300x
});

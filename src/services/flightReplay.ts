// Flight Replay — pure timeline/interpolation logic for FlightReplayScreen.
//
// No React / RN imports and erasable TypeScript only (no enums, namespaces or
// parameter properties), so `node --test` can import this .ts file directly
// (see test/flightReplay.test.mjs).
//
// Input is the GET /detections/:deploymentId?since=all row shape: one row per
// drone with uas_id, nickname, model, op_lat/op_lon, last_* and
// path: [{lat, lon, alt, ts}]. Everything is normalized defensively: pg
// NUMERIC arrives as strings, ts may be ISO / epoch ms / epoch seconds.
//
// Times are epoch ms. "Progress" is ms of ACTIVE time: the replay clock runs
// across the flight windows only, so idle hours between flights in a
// continuous deployment are skipped.

export type ReplayPoint = {
  t: number;
  lat: number;
  lon: number;
  // Meters above ground, or null when unknown.
  agl: number | null;
  // Ground speed m/s from the data, or null (then derived from spacing).
  spd: number | null;
};

export type ReplayDrone = {
  id: string;
  name: string;
  model: string | null;
  points: ReplayPoint[];
  start: number;
  end: number;
  // Operator / pilot position [lon, lat], or null.
  pilot: [number, number] | null;
};

export type FlightWindow = {
  start: number;
  end: number;
  // Active ms before this window (sum of earlier window durations).
  offset: number;
};

export type Replay = {
  drones: ReplayDrone[];
  windows: FlightWindow[];
  start: number;
  end: number;
  activeMs: number;
};

export type FrameState = 'pending' | 'flying' | 'done';

export type Frame = {
  state: FrameState;
  lat: number;
  lon: number;
  // Degrees clockwise from north, or null when it can't be known.
  bearing: number | null;
  speed: number | null;
  agl: number | null;
  // True when flying but parked on a point because the next one is more than
  // HOLD_GAP_MS away (signal lost / between flights).
  holding: boolean;
  // Index of the last point at or before t (-1 when pending).
  index: number;
};

export type Bounds = { minLat: number; maxLat: number; minLon: number; maxLon: number };

// Gaps up to this long between flight spans are one window.
export const MERGE_GAP_MS = 90_000;
// Every window lasts at least this long (single-point sightings get a beat).
export const MIN_WINDOW_MS = 5_000;
// Don't interpolate across gaps longer than this; hold the last position.
export const HOLD_GAP_MS = 120_000;

export const SPEEDS = [1, 5, 10, 30, 60, 120, 300];
export const TARGET_REPLAY_MS = 40_000;

// ---------------------------------------------------------------- normalize

export function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Epoch ms from epoch ms, epoch seconds (number or numeric string), ISO
// string or Date. Values below 1e11 are taken as seconds (1e11 ms is 1973;
// 1e11 s is year 5138), so both units round-trip for any realistic date.
export function normTs(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  let n: number | null = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const s = v.trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) n = Number(s);
    else {
      const t = Date.parse(s);
      return Number.isFinite(t) ? t : null;
    }
  }
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

export function validLatLon(lat: number | null, lon: number | null): boolean {
  if (lat == null || lon == null) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  // (0,0) is the Remote ID "no fix" value, never a real position here.
  return !(lat === 0 && lon === 0);
}

// ---------------------------------------------------------------- build

function rowId(row: any, i: number): string {
  const id = row?.uas_id ?? row?.uasId ?? row?.id ?? row?.mac;
  return id != null && String(id) !== '' ? String(id) : `drone-${i}`;
}

function rowPoints(row: any): ReplayPoint[] {
  // Per-point AGL: the backend computes alt_agl_m once per row against the
  // ground at the operator (else last) position, from last_altitude. Path
  // points carry the same HAE altitude source as `alt`, so a point's AGL
  // against that same ground is alt + (alt_agl_m - last_altitude).
  const rowAgl = num(row?.alt_agl_m);
  const rowAlt = num(row?.last_altitude);
  const aglOffset = rowAgl != null && rowAlt != null ? rowAgl - rowAlt : null;

  const out: ReplayPoint[] = [];
  const path = Array.isArray(row?.path) ? row.path : [];
  for (const p of path) {
    if (!p) continue;
    const t = normTs(p.ts ?? p.t ?? p.recorded_at ?? p.timestamp);
    const lat = num(p.lat);
    const lon = num(p.lon ?? p.lng);
    if (t == null || !validLatLon(lat, lon)) continue;
    let agl = num(p.alt_agl_m);
    if (agl == null && aglOffset != null) {
      const alt = num(p.alt);
      if (alt != null) agl = alt + aglOffset;
    }
    out.push({ t, lat: lat as number, lon: lon as number, agl, spd: num(p.spd ?? p.speed) });
  }
  if (out.length === 0) {
    // No usable path: fall back to the row's last fix as a single point.
    const t = normTs(row?.last_seen);
    const lat = num(row?.last_lat);
    const lon = num(row?.last_lon);
    if (t != null && validLatLon(lat, lon)) {
      out.push({ t, lat: lat as number, lon: lon as number, agl: rowAgl, spd: num(row?.last_speed) });
    }
  }
  return out;
}

// Sort by time; on duplicate timestamps keep the later-listed point.
function sortDedupe(points: ReplayPoint[]): ReplayPoint[] {
  const sorted = points
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.t - b.p.t || a.i - b.i)
    .map(x => x.p);
  const out: ReplayPoint[] = [];
  for (const p of sorted) {
    if (out.length && out[out.length - 1].t === p.t) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

export function buildWindows(drones: ReplayDrone[]): FlightWindow[] {
  // Split each drone's points into spans wherever its own gap exceeds the
  // merge threshold, so one row covering two flights hours apart doesn't
  // make the idle time "active".
  const spans: Array<[number, number]> = [];
  for (const d of drones) {
    let s = d.points[0].t;
    let prev = s;
    for (let i = 1; i < d.points.length; i++) {
      const t = d.points[i].t;
      if (t - prev > MERGE_GAP_MS) { spans.push([s, prev]); s = t; }
      prev = t;
    }
    spans.push([s, prev]);
  }
  for (const sp of spans) if (sp[1] - sp[0] < MIN_WINDOW_MS) sp[1] = sp[0] + MIN_WINDOW_MS;
  spans.sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] - last[1] <= MERGE_GAP_MS) last[1] = Math.max(last[1], sp[1]);
    else merged.push([sp[0], sp[1]]);
  }
  let offset = 0;
  return merged.map(([start, end]) => {
    const w = { start, end, offset };
    offset += end - start;
    return w;
  });
}

export function buildReplay(rows: any[], nicknames: Record<string, string> = {}): Replay {
  const byId = new Map<string, { row: any; points: ReplayPoint[] }>();
  (Array.isArray(rows) ? rows : []).forEach((row, i) => {
    if (!row || typeof row !== 'object') return;
    const id = rowId(row, i);
    const pts = rowPoints(row);
    const prev = byId.get(id);
    // Several rows for one UAS ID (e.g. relayed by different nodes) merge
    // into one drone; the most recently seen row supplies the metadata.
    if (prev) {
      prev.points.push(...pts);
      if ((normTs(row.last_seen) ?? 0) > (normTs(prev.row.last_seen) ?? 0)) prev.row = row;
    } else {
      byId.set(id, { row, points: pts });
    }
  });

  const drones: ReplayDrone[] = [];
  for (const [id, { row, points }] of byId) {
    const pts = sortDedupe(points);
    if (pts.length === 0) continue;
    const opLat = num(row.op_lat);
    const opLon = num(row.op_lon);
    const nick = nicknames[id] || (typeof row.nickname === 'string' ? row.nickname.trim() : '');
    drones.push({
      id,
      name: nick || id,
      model: row.model ? String(row.model) : null,
      points: pts,
      start: pts[0].t,
      end: pts[pts.length - 1].t,
      pilot: validLatLon(opLat, opLon) ? [opLon as number, opLat as number] : null,
    });
  }
  drones.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));

  const windows = drones.length ? buildWindows(drones) : [];
  const last = windows[windows.length - 1];
  return {
    drones,
    windows,
    start: windows.length ? windows[0].start : 0,
    end: last ? last.end : 0,
    activeMs: last ? last.offset + (last.end - last.start) : 0,
  };
}

// ---------------------------------------------------------------- timeline

export function windowIndexAt(windows: FlightWindow[], progress: number): number {
  if (windows.length === 0) return -1;
  for (let i = windows.length - 1; i >= 0; i--) {
    if (progress >= windows[i].offset) return i;
  }
  return 0;
}

// Active-time progress (ms) → wall-clock epoch ms.
export function toRealTime(windows: FlightWindow[], progress: number): number {
  if (windows.length === 0) return 0;
  const i = windowIndexAt(windows, Math.max(0, progress));
  const w = windows[i];
  return Math.min(w.end, w.start + Math.max(0, progress - w.offset));
}

// Wall-clock epoch ms → active-time progress. A time inside a gap maps to the
// start of the next window; before / after everything clamps.
export function toProgress(windows: FlightWindow[], t: number): number {
  if (windows.length === 0) return 0;
  for (const w of windows) {
    if (t < w.start) return w.offset;
    if (t <= w.end) return w.offset + (t - w.start);
  }
  const last = windows[windows.length - 1];
  return last.offset + (last.end - last.start);
}

// Smallest speed that fits the whole replay in about TARGET_REPLAY_MS.
export function autoSpeedIndex(activeMs: number, speeds: number[] = SPEEDS, targetMs = TARGET_REPLAY_MS): number {
  for (let i = 0; i < speeds.length; i++) {
    if (activeMs / speeds[i] <= targetMs) return i;
  }
  return speeds.length - 1;
}

// ---------------------------------------------------------------- geometry

const EARTH_R = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;

export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat))
    - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Last point index with t <= time, or -1.
function indexAt(points: ReplayPoint[], time: number): number {
  let lo = 0;
  let hi = points.length - 1;
  if (hi < 0 || time < points[0].t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].t <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Bearing of the most recent movement ending at or before index i.
function bearingBack(points: ReplayPoint[], i: number): number | null {
  for (let j = i; j > 0; j--) {
    const a = points[j - 1];
    const b = points[j];
    if (b.t - a.t > HOLD_GAP_MS) return null;
    if (a.lat !== b.lat || a.lon !== b.lon) return bearingDeg(a, b);
  }
  return null;
}

function derivedSpeed(a: ReplayPoint, b: ReplayPoint): number | null {
  const dt = (b.t - a.t) / 1000;
  return dt > 0 ? distanceM(a, b) / dt : null;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const lerpN = (a: number | null, b: number | null, f: number): number | null =>
  a != null && b != null ? lerp(a, b, f) : (a ?? b);

export function frameAt(drone: ReplayDrone, t: number): Frame {
  const pts = drone.points;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (t < first.t) {
    return { state: 'pending', lat: first.lat, lon: first.lon, bearing: null, speed: null, agl: null, holding: false, index: -1 };
  }
  if (t > last.t || pts.length === 1) {
    const i = pts.length - 1;
    return {
      state: t > last.t ? 'done' : 'flying',
      lat: last.lat, lon: last.lon,
      bearing: bearingBack(pts, i),
      speed: last.spd ?? (i > 0 ? derivedSpeed(pts[i - 1], last) : null),
      agl: last.agl, holding: false, index: i,
    };
  }
  const i = indexAt(pts, t);
  const a = pts[i];
  if (i === pts.length - 1) {
    return { state: 'flying', lat: a.lat, lon: a.lon, bearing: bearingBack(pts, i), speed: a.spd, agl: a.agl, holding: false, index: i };
  }
  const b = pts[i + 1];
  const gap = b.t - a.t;
  if (gap > HOLD_GAP_MS) {
    // Too long to draw a straight line across: park on the last fix.
    return { state: 'flying', lat: a.lat, lon: a.lon, bearing: bearingBack(pts, i), speed: a.spd, agl: a.agl, holding: true, index: i };
  }
  const f = gap > 0 ? (t - a.t) / gap : 0;
  const moved = a.lat !== b.lat || a.lon !== b.lon;
  return {
    state: 'flying',
    lat: lerp(a.lat, b.lat, f),
    lon: lerp(a.lon, b.lon, f),
    bearing: moved ? bearingDeg(a, b) : bearingBack(pts, i),
    speed: a.spd != null || b.spd != null ? lerpN(a.spd, b.spd, f) : derivedSpeed(a, b),
    agl: lerpN(a.agl, b.agl, f),
    holding: false,
    index: i,
  };
}

// ---------------------------------------------------------------- trails

// Lines as [lon, lat] coordinate arrays, broken wherever the gap between
// points exceeds HOLD_GAP_MS. Lines with fewer than 2 coordinates are dropped
// (a valid MultiLineString needs >= 2 per line).
function splitLines(points: ReplayPoint[], upTo: number, tail: [number, number] | null): number[][][] {
  const lines: number[][][] = [];
  let cur: number[][] = [];
  for (let i = 0; i <= upTo && i < points.length; i++) {
    if (i > 0 && points[i].t - points[i - 1].t > HOLD_GAP_MS) {
      if (cur.length >= 2) lines.push(cur);
      cur = [];
    }
    cur.push([points[i].lon, points[i].lat]);
  }
  if (tail) cur.push(tail);
  if (cur.length >= 2) lines.push(cur);
  return lines;
}

export function fullTrail(drone: ReplayDrone): number[][][] {
  return splitLines(drone.points, drone.points.length - 1, null);
}

// The "flown so far" trail at time t. Pass the frame from frameAt(drone, t)
// to avoid recomputing it; the interpolated position is appended while the
// drone is between two points.
export function trailUpTo(drone: ReplayDrone, t: number, frame?: Frame): number[][][] {
  const fr = frame ?? frameAt(drone, t);
  if (fr.state === 'pending' || fr.index < 0) return [];
  const a = drone.points[fr.index];
  const between = fr.state === 'flying' && !fr.holding && (fr.lat !== a.lat || fr.lon !== a.lon);
  return splitLines(drone.points, fr.index, between ? [fr.lon, fr.lat] : null);
}

export function boundsOf(drones: ReplayDrone[]): Bounds | null {
  let b: Bounds | null = null;
  const add = (lat: number, lon: number) => {
    if (!b) b = { minLat: lat, maxLat: lat, minLon: lon, maxLon: lon };
    else {
      if (lat < b.minLat) b.minLat = lat;
      if (lat > b.maxLat) b.maxLat = lat;
      if (lon < b.minLon) b.minLon = lon;
      if (lon > b.maxLon) b.maxLon = lon;
    }
  };
  for (const d of drones) {
    for (const p of d.points) add(p.lat, p.lon);
    if (d.pilot) add(d.pilot[1], d.pilot[0]);
  }
  return b;
}

// m:ss under an hour, else h:mm:ss. Negative / non-finite → 0:00.
export function fmtElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

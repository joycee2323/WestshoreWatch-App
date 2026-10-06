// Shared imperial unit conversion + formatting. DISPLAY ONLY — storage, API
// payloads, the store, and firmware stay metric (meters, m·s⁻¹). Convert ONLY
// at render.
//
// Conversions: 1 m = 3.28084 ft, 1 m/s = 2.23694 mph, inverses 1 ft = 0.3048 m,
// 1 mph = 0.44704 m/s.

const M_TO_FT = 3.28084;
const MS_TO_MPH = 2.23694;
const FT_TO_M = 0.3048;
const MPH_TO_MS = 0.44704;
const FT_PER_MILE = 5280;

type Num = number | null | undefined;

// Numeric converters. Null/undefined pass through as null.
export function toFeet(m: Num): number | null {
  if (m == null) return null;
  const n = Number(m);
  return Number.isFinite(n) ? n * M_TO_FT : null;
}
export function toMph(ms: Num): number | null {
  if (ms == null) return null;
  const n = Number(ms);
  return Number.isFinite(n) ? n * MS_TO_MPH : null;
}
// °C → °F for display only. Storage, thresholds, and the alert comparison stay
// Celsius (silicon limits); we only convert the number the user sees.
export function cToF(celsius: Num): number | null {
  if (celsius == null) return null;
  const n = Number(celsius);
  return Number.isFinite(n) ? n * 9 / 5 + 32 : null;
}

// Display formatters (rounding: altitude = whole feet; speed = 1-decimal mph;
// distance = whole feet under 1000 ft, else miles to 2 decimals).
export function fmtAltitude(m: Num): string {
  const ft = toFeet(m);
  return ft == null ? '—' : `${Math.round(ft)} ft`;
}
// Live drone altitude: AGL only, from the backend's alt_agl_m (the same rule
// as the export's "Altitude AGL (ft)" that Flight Replay shows). When AGL is
// unknown this says so. It never falls back to the HAE last_altitude.
// Negative AGL shows as "0 ft AGL". Keep in
// step with fmtAgl in the dashboard's src/utils/units.js.
export function fmtAgl(aglM: Num): string {
  const ft = toFeet(aglM);
  // Below the ground elevation used (GPS/terrain-model error) displays as 0;
  // the raw negative value stays in the payload.
  return ft == null ? 'AGL n/a' : `${Math.max(0, Math.round(ft))} ft AGL`;
}
export function fmtSpeed(ms: Num): string {
  const mph = toMph(ms);
  return mph == null ? '—' : `${mph.toFixed(1)} mph`;
}
export function fmtDistance(m: Num): string {
  const ft = toFeet(m);
  if (ft == null) return '—';
  return ft < 1000 ? `${Math.round(ft)} ft` : `${(ft / FT_PER_MILE).toFixed(2)} mi`;
}
// Temperature: whole degrees Fahrenheit; null/non-finite → em dash.
export function fmtTemp(celsius: Num): string {
  const f = cToF(celsius);
  return f == null ? '—' : `${Math.round(f)}°F`;
}

// CSV-parse normalizers (kept for parity with the other repos; the app has no
// CSV import today). Imperial header → convert back to metric; else pass through.
export function altInbound(header: string): (v: number | null) => number | null {
  return /\(ft\)/i.test(header || '')
    ? (v) => (v == null || !Number.isFinite(Number(v)) ? v : Number(v) * FT_TO_M)
    : (v) => v;
}
export function speedInbound(header: string): (v: number | null) => number | null {
  return /\(mph\)/i.test(header || '')
    ? (v) => (v == null || !Number.isFinite(Number(v)) ? v : Number(v) * MPH_TO_MS)
    : (v) => v;
}

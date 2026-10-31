// Detection upload body for one drone — the wire shape of
// POST /api/deployments/:id/detections (node-less JS path) and, field for
// field, of the native uploaders (DetectionUploader.kt, WSWDetectionUploader
// .swift) and the Sentinel-Pi translator. Pure (no React Native imports) so it
// can be unit-tested under plain Node: test/uploadPayload.test.mjs.
//
// status / height / vspd feed the backend's grounded-aircraft state
// (WestshoreWatch-Backend services/groundedState.js). Same names and units as
// Sentinel-Pi translator.py: status = ODID operational status 0-4 (integer),
// height = metres, vspd = vertical speed m/s (positive up). Unknown or
// invalid values are sent as null — the parser already maps the ODID invalid
// sentinels to undefined — and the backend fails open on null.
//
// decoder / loc_raw: sent ONLY for frames decoded from a relay-format-2 spec
// Location (odidParser.ts RELAY_FORMAT_SPEC). Legacy frames omit both keys —
// the same body as app 1.2.4 — so the backend keeps flagging them.

export interface UploadRecord {
  id: string;          // uasId
  lat: number;
  lon: number;
  alt?: number | null; // geodetic altitude (m)
  spd?: number | null; // horizontal speed (m/s)
  hdg?: number | null; // heading (deg)
  op_lat?: number | null;
  op_lon?: number | null;
  ts?: number | null;  // ODID Location timestamp (deciseconds since the UTC hour)
  status?: number | null; // ODID operational status 0-4
  height?: number | null; // m, relative to the frame's height type
  vspd?: number | null;   // vertical speed m/s, positive up
  decoder?: string;       // 'odid-spec-1' (relay format 2 only)
  loc_raw?: string;       // 50 hex chars (relay format 2 only)
}

export function uploadBody(d: UploadRecord) {
  const body: Record<string, unknown> = {
    id: d.id, lat: d.lat, lon: d.lon,
    alt: d.alt ?? null, spd: d.spd ?? null, hdg: d.hdg ?? null,
    op_lat: d.op_lat ?? null, op_lon: d.op_lon ?? null, ts: d.ts ?? null,
    status: d.status ?? null, height: d.height ?? null, vspd: d.vspd ?? null,
  };
  if (d.decoder && d.loc_raw) {
    body.decoder = d.decoder;
    body.loc_raw = d.loc_raw;
  }
  return body;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadBody } from '../src/services/uploadPayload.ts';

// Run with: node --test test/*.test.mjs   (not a package.json script — see fmtAgl.test.mjs).
// The node-less detection upload body (iOS relay path). Field names and units
// must match the Sentinel-Pi upload (translator.py) and the native uploaders.

test('docked Skydio record: status / height / vspd sent with the Sentinel field names', () => {
  const body = uploadBody({
    id: '1668BR40FA0098ER', lat: 41.4611922, lon: -81.9237012, alt: 179, spd: 0, hdg: 0,
    op_lat: 41.4559348, op_lon: -81.9238019, ts: 1234, status: 1, height: -1, vspd: 0,
  });
  assert.deepEqual(body, {
    id: '1668BR40FA0098ER', lat: 41.4611922, lon: -81.9237012, alt: 179, spd: 0, hdg: 0,
    op_lat: 41.4559348, op_lon: -81.9238019, ts: 1234, status: 1, height: -1, vspd: 0,
  });
});

test('regression: a record built without the new fields still uploads, with nulls', () => {
  // Shape of every record queued before this change.
  const body = uploadBody({ id: 'DRONE-1', lat: 41.5, lon: -81.7, alt: 200, spd: 3, hdg: 90, ts: 77 });
  assert.deepEqual(body, {
    id: 'DRONE-1', lat: 41.5, lon: -81.7, alt: 200, spd: 3, hdg: 90,
    op_lat: null, op_lon: null, ts: 77, status: null, height: null, vspd: null,
  });
});

test('unknown values are null, never a sentinel number; 0 is kept', () => {
  const body = uploadBody({ id: 'X', lat: 1, lon: 2, status: undefined, height: undefined, vspd: undefined, alt: undefined });
  assert.equal(body.status, null);
  assert.equal(body.height, null);
  assert.equal(body.vspd, null);
  assert.equal(body.alt, null);
  const zeros = uploadBody({ id: 'X', lat: 1, lon: 2, status: 0, height: 0, vspd: 0 });
  assert.equal(zeros.status, 0);
  assert.equal(zeros.height, 0);
  assert.equal(zeros.vspd, 0);
});

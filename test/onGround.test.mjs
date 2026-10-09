import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOnGroundFrame, guestStatusLabel } from '../src/services/onGround.ts';

// Run with: node --test test/*.test.mjs   (not a package.json script — see fmtAgl.test.mjs).
// Display-only rule: matching frames are greyed / labelled, never hidden.

test('docked Skydio frame (status 1, speed 0, height -1.0) is on ground', () => {
  assert.equal(isOnGroundFrame({ status: 1, speedHoriz: 0, height: -1 }), true);
  assert.equal(guestStatusLabel({ status: 1, speedHoriz: 0, height: -1 }), '● ON GROUND');
});

test('height unknown still counts; boundaries are inclusive', () => {
  assert.equal(isOnGroundFrame({ status: 1, speedHoriz: 0 }), true);
  assert.equal(isOnGroundFrame({ status: 1, speedHoriz: 0, height: null }), true);
  assert.equal(isOnGroundFrame({ status: 1, speedHoriz: 0.5, height: 3 }), true);
});

test('any one rule failing means not on ground', () => {
  assert.equal(isOnGroundFrame({ status: 1, speedHoriz: 0.51, height: 0 }), false); // moving
  assert.equal(isOnGroundFrame({ status: 1, speedHoriz: 0, height: 3.5 }), false);   // above 3 m
  assert.equal(isOnGroundFrame({ status: 2, speedHoriz: 0, height: 0 }), false);     // airborne
  assert.equal(isOnGroundFrame({ status: 0, speedHoriz: 0, height: 0 }), false);     // undeclared
  assert.equal(isOnGroundFrame({ speedHoriz: 0, height: 0 }), false);                // status unknown
  assert.equal(isOnGroundFrame({ status: 1, height: 0 }), false);                    // speed unknown
  assert.equal(isOnGroundFrame({ status: 1, speedHoriz: Number.NaN }), false);
  assert.equal(isOnGroundFrame(null), false);
});

test('KNOWN LIMIT: a low hover falsely reporting status 1 is greyed — but still drawn', () => {
  // The rule only greys/labels; the caller never filters on it, so the drone
  // stays on screen and alerts are untouched.
  assert.equal(isOnGroundFrame({ status: 1, speedHoriz: 0.2, height: 2 }), true);
});

test('guest status labels for the other cases', () => {
  assert.equal(guestStatusLabel({ status: 2, speedHoriz: 5 }), '↑ AIRBORNE');
  assert.equal(guestStatusLabel({ status: 3, speedHoriz: 0 }), '⚠ EMERGENCY');
  assert.equal(guestStatusLabel({ status: 1, speedHoriz: 4 }), '○ GROUND STATUS');
  assert.equal(guestStatusLabel({ status: 0, speedHoriz: 0 }), '○ STATUS UNKNOWN');
  assert.equal(guestStatusLabel({}), '○ STATUS UNKNOWN');
});

test('guard: the on-ground rule is display-only — never a filter, never in the alert path', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = async p => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
  for (const p of ['src/screens/LiveMapScreen.tsx', 'src/screens/GuestScanScreen.tsx']) {
    const s = await src(p);
    assert.equal(/\.filter\([^)]*isOnGroundFrame/.test(s), false, `${p} must not filter on isOnGroundFrame`);
    assert.equal(/isOnGroundFrame\([^)]*\)\s*\)?\s*(return|continue)/.test(s), false, `${p} must not skip on isOnGroundFrame`);
  }
  for (const p of ['src/services/bleScanner.ts', 'src/services/droneNotifier.ts', 'src/services/detectionUpload.ts']) {
    assert.equal((await src(p)).includes('onGround'), false, `${p} must not use the display rule`);
  }
});

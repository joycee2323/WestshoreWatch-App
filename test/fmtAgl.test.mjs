import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtAgl } from '../src/utils/units.ts';

// Run with: node --test test/   (Node 22.18+ / 24 strips the .ts types).
// Deliberately NOT a package.json script: @expo/fingerprint hashes
// packageJson:scripts, so adding one would change the runtime fingerprint and
// stop this JS-only change from shipping as an OTA update.

// The same cases run against the dashboard (src/utils/units.js) and the app
// (src/utils/units.ts) copies of fmtAgl, so the two cannot drift. Keep the
// two test files identical apart from the import and how to run them. The Wear watch's
// format/Agl.kt is checked against the same cases in AglTest.kt.
const CASES = [
  [36.576, '120 ft AGL'],
  ['36.576', '120 ft AGL'],  // pg DECIMAL arrives as a string
  [0, '0 ft AGL'],
  [-3.7, '0 ft AGL'],        // below the ground used: clamped, not "-12 ft AGL"
  [-0.1, '0 ft AGL'],        // rounds to -0: still "0", never "-0"
  [0.1524, '1 ft AGL'],      // ≈0.50000002 ft rounds up (Wear AglTest has the same case)
  [null, 'AGL n/a'],
  [undefined, 'AGL n/a'],
  [NaN, 'AGL n/a'],
];

for (const [input, expected] of CASES) {
  test(`fmtAgl(${String(input)}) → ${expected}`, () => {
    assert.equal(fmtAgl(input), expected);
  });
}

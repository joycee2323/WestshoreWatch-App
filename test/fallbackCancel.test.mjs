import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejectionCancelsFallback } from '../src/services/fallbackCancel.ts';

// Run with: node --test test/*.test.mjs   (not a package.json script — see fmtAgl.test.mjs).

test('"grounded" always cancels the local fallback, whatever the ts', () => {
  assert.equal(rejectionCancelsFallback(1200, 1234, 'grounded'), true);
  assert.equal(rejectionCancelsFallback(1200, null, 'grounded'), true);
  assert.equal(rejectionCancelsFallback(null, 1234, 'grounded'), true);
});

test('stale reasons keep the existing same-frame rule', () => {
  for (const reason of ['too_old', 'unchanged', 'out_of_order', 'frozen', undefined]) {
    assert.equal(rejectionCancelsFallback(1200, 1234, reason), false, `${reason}: different frame must not cancel`);
    assert.equal(rejectionCancelsFallback(1200, 1200, reason), true, `${reason}: same frame cancels`);
    assert.equal(rejectionCancelsFallback(null, 1234, reason), true, `${reason}: no armed ts`);
    assert.equal(rejectionCancelsFallback(1200, null, reason), true, `${reason}: no rejected ts`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectedByNodesLabel } from '../src/services/detectedByNodes.ts';

// Run with: node --test test/*.test.mjs

test('live node first, then the other nodes recorded this flight', () => {
  assert.equal(
    detectedByNodesLabel('South Gate X1', [{ id: 'n', name: 'North Gate X1' }, { id: 's', name: 'South Gate X1' }]),
    'South Gate X1, North Gate X1',
  );
});

test('no per-flight list (older backend / unstamped data) → live node only, as before', () => {
  assert.equal(detectedByNodesLabel('North Gate X1', undefined), 'North Gate X1');
  assert.equal(detectedByNodesLabel('North Gate X1', []), 'North Gate X1');
});

test('no live node: the flight list alone; nothing at all → em dash', () => {
  assert.equal(detectedByNodesLabel(null, [{ name: 'Roof Sentinel' }]), 'Roof Sentinel');
  assert.equal(detectedByNodesLabel(undefined, null), '—');
  assert.equal(detectedByNodesLabel('  ', [null, { name: '' }]), '—');
});

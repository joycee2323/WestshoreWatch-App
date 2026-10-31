import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentPickerOptions, deploymentPickerPrompt } from '../src/services/deploymentPicker.ts';

// Run with: node --test test/*.test.mjs   (not a package.json script — see fmtAgl.test.mjs).
// The old Alert.alert picker lost every option past the 3rd on Android; the
// modal picker must offer every deployment, in order.

const deps = n => Array.from({ length: n }, (_, i) => ({ id: `d${i + 1}`, name: `Deployment ${i + 1}` }));

test('every deployment becomes an option, in order, for 1 to 6 deployments', () => {
  for (let n = 1; n <= 6; n++) {
    const opts = deploymentPickerOptions(deps(n));
    assert.equal(opts.length, n);
    assert.deepEqual(opts.map(o => o.id), deps(n).map(d => d.id));
    assert.deepEqual(opts.map(o => o.label), deps(n).map(d => d.name));
  }
});

test('the 4th deployment (lost by the Android Alert) is offered', () => {
  const opts = deploymentPickerOptions([
    { id: 'a', name: 'Flyguys Asseti' }, { id: 'b', name: 'Skydio Diag Test' },
    { id: 'c', name: 'Home Overwatch' }, { id: 'd', name: 'Fairview Park Overwatch' },
  ]);
  assert.deepEqual(opts[3], { id: 'd', label: 'Fairview Park Overwatch' });
});

test('missing or blank names fall back to the id; rows without an id are skipped', () => {
  assert.deepEqual(
    deploymentPickerOptions([{ id: 'x' }, { id: 'y', name: '  ' }, { name: 'no id' }, null, { id: 'z', name: ' Ops ' }]),
    [{ id: 'x', label: 'x' }, { id: 'y', label: 'y' }, { id: 'z', label: 'Ops' }],
  );
});

test('empty and missing lists give no options', () => {
  assert.deepEqual(deploymentPickerOptions([]), []);
  assert.deepEqual(deploymentPickerOptions(null), []);
  assert.deepEqual(deploymentPickerOptions(undefined), []);
});

test('prompt matches the old Alert message', () => {
  assert.equal(deploymentPickerPrompt('Cellular X1 - 1'), 'Select a deployment for "Cellular X1 - 1"');
  assert.equal(deploymentPickerPrompt(''), 'Select a deployment for "this node"');
  assert.equal(deploymentPickerPrompt(null), 'Select a deployment for "this node"');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Run with: node --test test/   (same as the other tests; see fmtAgl.test.mjs
// for why this is not a package.json script).

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = require('../plugins/withAndroidAuto.js');
const fingerprintConfig = require('../fingerprint.config.js');

const lf = (s) => s.replace(/\r\n/g, '\n');

test('gradle block: appended once, idempotent on re-run', () => {
  const src = 'apply plugin: "com.android.application"\n\ndependencies {\n}\n';
  const once = plugin.applyGradleBlock(src);
  assert.ok(once.includes('androidx.car.app:app:1.7.0'));
  assert.equal(plugin.applyGradleBlock(once), once);
  assert.equal(once.split('@generated begin withAndroidAuto').length, 2);
});

test('gradle block: an outdated block is replaced in place, not duplicated', () => {
  const stale = 'x\n// @generated begin withAndroidAuto old\nold stuff\n// @generated end withAndroidAuto\ny\n';
  const out = plugin.applyGradleBlock(stale);
  assert.ok(!out.includes('old stuff'));
  assert.ok(out.startsWith('x\n'));
  assert.ok(out.endsWith('\ny\n'));
  assert.equal(out.split('@generated begin withAndroidAuto').length, 2);
});

test('committed android/app/build.gradle carries exactly the plugin block', () => {
  const gradle = lf(readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8'));
  assert.ok(gradle.includes(plugin.GRADLE_BLOCK), 'committed build.gradle is out of sync with plugins/withAndroidAuto.js');
  assert.equal(plugin.applyGradleBlock(gradle), gradle);
});

function emptyManifest() {
  return {
    manifest: {
      $: {},
      'uses-permission': [{ $: { 'android:name': 'android.permission.INTERNET' } }],
      application: [{ $: { 'android:name': '.MainApplication' }, 'meta-data': [], service: [], activity: [] }],
    },
  };
}

test('manifest: adds permission, meta-data and POI service; idempotent', () => {
  const once = plugin.applyManifest(emptyManifest());
  const snapshot = JSON.stringify(once);
  const twice = plugin.applyManifest(JSON.parse(snapshot));
  assert.equal(JSON.stringify(twice), snapshot);

  const m = once.manifest;
  const perms = m['uses-permission'].map((p) => p.$['android:name']);
  assert.deepEqual(perms.filter((p) => p === 'androidx.car.app.MAP_TEMPLATES').length, 1);
  const app = m.application[0];
  const meta = Object.fromEntries(app['meta-data'].map((md) => [md.$['android:name'], md.$]));
  assert.equal(meta['com.google.android.gms.car.application']['android:resource'], '@xml/automotive_app_desc');
  assert.equal(meta['androidx.car.app.minCarApiLevel']['android:value'], '5');
  const svc = app.service.filter((s) => s.$['android:name'] === '.auto.WswCarAppService');
  assert.equal(svc.length, 1);
  assert.equal(svc[0].$['android:exported'], 'true');
  assert.equal(svc[0]['intent-filter'][0].category[0].$['android:name'], 'androidx.car.app.category.POI');
});

test('committed AndroidManifest.xml declares the same car entries', () => {
  const xml = readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  for (const needle of [
    '<uses-permission android:name="androidx.car.app.MAP_TEMPLATES"/>',
    '<meta-data android:name="com.google.android.gms.car.application" android:resource="@xml/automotive_app_desc"/>',
    '<meta-data android:name="androidx.car.app.minCarApiLevel" android:value="5"/>',
    '<service android:name=".auto.WswCarAppService" android:exported="true"',
    '<action android:name="androidx.car.app.CarAppService"/>',
    '<category android:name="androidx.car.app.category.POI"/>',
  ]) {
    assert.ok(xml.includes(needle), `missing: ${needle}`);
  }
});

test('fingerprint: Android-only plugin entry is stripped from the hashed expo config', () => {
  const contents = JSON.stringify({
    name: 'x',
    plugins: [['@rnmapbox/maps', {}], './plugins/withBleScanner', './plugins/withAndroidAuto'],
  });
  const out = fingerprintConfig.fileHookTransform({ type: 'contents', id: 'expoConfig' }, contents, true, 'utf8');
  assert.equal(out, JSON.stringify({ name: 'x', plugins: [['@rnmapbox/maps', {}], './plugins/withBleScanner'] }));
  // Other sources and unrelated contents pass through untouched.
  assert.equal(fingerprintConfig.fileHookTransform({ type: 'file', filePath: 'a.js' }, 'abc', true, 'utf8'), 'abc');
  const plain = JSON.stringify({ plugins: ['./plugins/withBleScanner'] });
  assert.equal(fingerprintConfig.fileHookTransform({ type: 'contents', id: 'expoConfig' }, plain, true, 'utf8'), plain);
  assert.ok(fingerprintConfig.ignorePaths.includes('plugins/withAndroidAuto.js'));
});

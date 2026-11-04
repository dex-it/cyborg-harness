import { test } from 'node:test';
import assert from 'node:assert/strict';
import { satisfies, isValidRange } from '../src/semver.ts';
import { parseManifest } from '../src/manifest.ts';

test('диапазоны: каретка, тильда, префикс и звезда', () => {
  assert.ok(satisfies('1.4.0', '^1'));
  assert.ok(satisfies('1.9.9', '^1.4'));
  assert.ok(!satisfies('1.3.9', '^1.4'));
  assert.ok(!satisfies('2.0.0', '^1'));
  assert.ok(satisfies('0.2.5', '^0.2'));
  assert.ok(!satisfies('0.3.0', '^0.2'));
  assert.ok(!satisfies('0.0.4', '^0.0.3'));
  assert.ok(satisfies('1.2.9', '~1.2'));
  assert.ok(!satisfies('1.3.0', '~1.2'));
  assert.ok(satisfies('1.4', '1.4'));
  assert.ok(!satisfies('1.5', '1.4'));
  assert.ok(satisfies('7.0.0', '*'));
  assert.ok(!isValidRange('>=1'));
  assert.ok(!satisfies('1.x', '^1'));
});

const base = { id: 'pin-lock', version: '1.0.0', engines: { cyborg: '^1' } };

test('манифест: минимальный приводится к полной форме', () => {
  const r = parseManifest({ ...base, provides: { 'cyborg.lock': '1.0' } });
  assert.ok(r.ok);
  assert.deepEqual(r.manifest.provides, { 'cyborg.lock': ['1.0'] });
  assert.deepEqual(r.manifest.requires, {});
  assert.deepEqual(r.manifest.commands, []);
});

test('манифест: ошибки собираются все сразу и id сохраняется для журнала', () => {
  const r = parseManifest({
    ...base,
    version: 'one',
    engines: { cyborg: '>=1' },
    provides: { 'cyborg.lock': ['1.0', '1.2'] },
    requires: { 'cyborg.files': '^1' },
    optional: { 'cyborg.files': '^1' },
    commands: ['other.lock'],
    config: { version: 0 },
  });
  assert.ok(!r.ok);
  assert.equal(r.id, 'pin-lock');
  assert.equal(r.errors.length, 6);
});

test('манифест: контракт many не может быть одновременно one', () => {
  const r = parseManifest({ ...base, requires: { 'cyborg.tab': '^1' }, consumes: { 'cyborg.tab': '^1' } });
  assert.ok(!r.ok);
});

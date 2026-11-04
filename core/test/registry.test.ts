import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGraph } from '../src/graph.ts';
import { parseManifest, type PluginManifest } from '../src/manifest.ts';
import { ContractRegistry } from '../src/registry.ts';

function m(id: string, fields: Record<string, unknown> = {}): PluginManifest {
  const r = parseManifest({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.manifest;
}

function registry(manifests: PluginManifest[]) {
  return new ContractRegistry(manifests, resolveGraph(manifests, '1.0.0').bindings);
}

const files = m('files', { provides: { 'cyborg.files': ['1.4', '2.0'] } });
const oldUser = m('old', { requires: { 'cyborg.files': '^1' } });
const newUser = m('new', { optional: { 'cyborg.files': '^2' } });

test('потребитель получает свою мажорную версию от того же поставщика', () => {
  const r = registry([files, oldUser, newUser]);
  r.provide('files', 'cyborg.files', '1.4', { v: 1 });
  r.provide('files', 'cyborg.files', '2.0', { v: 2 });
  assert.deepEqual(r.get('old', 'cyborg.files'), { v: 1 });
  assert.deepEqual(r.get('new', 'cyborg.files'), { v: 2 });
});

test('необъявленное не отдаётся и не берётся', () => {
  const r = registry([files, oldUser]);
  assert.throws(() => r.provide('files', 'cyborg.files', '1.5', {}), { code: 'NotDeclared' });
  assert.throws(() => r.provide('old', 'cyborg.files', '1.4', {}), { code: 'NotDeclared' });
  assert.throws(() => r.get('files', 'cyborg.files'), { code: 'NotDeclared' });
});

test('requires без отданного контракта - Unavailable, optional - undefined', () => {
  const r = registry([files, oldUser, newUser]);
  assert.throws(() => r.get('old', 'cyborg.files'), { code: 'Unavailable' });
  assert.equal(r.get('new', 'cyborg.files'), undefined);
});

test('consumes: все поставщики, onChange на приход и уход, снятие по dispose', () => {
  const ms = [
    m('editor', { provides: { 'cyborg.tab': '1.0' } }),
    m('viewer', { provides: { 'cyborg.tab': '1.1' } }),
    m('shell', { consumes: { 'cyborg.tab': '^1' } }),
  ];
  const r = registry(ms);
  let changes = 0;
  r.onChange('shell', 'cyborg.tab', () => changes++);
  const a = r.provide('editor', 'cyborg.tab', '1.0', { kind: 'editor' });
  r.provide('viewer', 'cyborg.tab', '1.1', { kind: 'viewer' });
  assert.deepEqual(r.all('shell', 'cyborg.tab').map((p) => p.pluginId), ['editor', 'viewer']);
  a.dispose();
  a.dispose();
  assert.deepEqual(r.all('shell', 'cyborg.tab').map((p) => p.pluginId), ['viewer']);
  assert.equal(changes, 3);
});

test('replace: зеркало хоста заменяет поставщиков целиком и зовёт onChange', () => {
  const r = registry([files, oldUser, newUser]);
  let changes = 0;
  r.onChange('new', 'cyborg.files', () => changes++);
  r.replace('cyborg.files', [{ pluginId: 'files', version: '2.0', impl: { v: 2 } }]);
  assert.deepEqual(r.get('new', 'cyborg.files'), { v: 2 });
  r.replace('cyborg.files', []);
  assert.equal(r.get('new', 'cyborg.files'), undefined);
  assert.equal(changes, 2);
});

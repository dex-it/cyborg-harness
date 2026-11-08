import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

// Соглашение до правила P-01: мажор API плагинов равен мажору пакета контрактов, иначе плагин собран под одни типы, а грузится под другой API.
test('мажор PLUGIN_API_VERSION равен мажору @cyborg-harness/contracts', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../contracts/package.json', import.meta.url), 'utf8')) as { version: string };
  const major = (v: string) => v.split('.')[0];
  assert.equal(major(PLUGIN_API_VERSION), major(pkg.version));
});

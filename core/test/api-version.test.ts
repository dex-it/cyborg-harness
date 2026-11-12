import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { allowsMajor, isValidRange, parseVersion, satisfies } from '../src/semver.ts';

// T-03, P-01, K-21: три версии (пакета контрактов, API плагина, engines.cyborg плагинов) согласованы. Правила - contracts/README.md, «Три версии».
const repo = path.resolve(import.meta.dirname, '..', '..');
const json = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(repo, rel), 'utf8')) as Record<string, unknown>;
const packageVersion = (): string => String(json('contracts/package.json').version);
const numbers = (version: string): [number, number, number] => {
  const [a = 0, b = 0, c = 0] = (version.split(/[-+]/)[0] ?? '').split('.').map(Number);
  return [a, b, c];
};
const cmp = (a: readonly number[], b: readonly number[]): number => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);

/** Манифесты встроенных плагинов стенда, шаблона автора и его проверочного потребителя: каждый объявляет `engines.cyborg`. */
function builtInManifests(): string[] {
  const plugins = readdirSync(path.join(repo, 'playground', 'plugins'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(repo, 'playground', 'plugins', d.name, 'manifest.json')))
    .map((d) => `playground/plugins/${d.name}/manifest.json`);
  return [...plugins, 'templates/plugin/manifest.json', 'templates/plugin/test/consumer/manifest.json'];
}

/** Правило разбора диапазона peer-зависимости вида `>=A <B`: версия пакета в нём. */
function peerAccepts(range: string, version: string): boolean {
  const m = />=(\S+)\s+<(\S+)/.exec(range);
  if (!m?.[1] || !m[2]) return false;
  return cmp(numbers(version), numbers(m[1])) >= 0 && cmp(numbers(version), numbers(m[2])) < 0;
}

test('ST-5001/5: мажор PLUGIN_API_VERSION равен мажору @cyborg-harness/contracts', () => {
  const major = (v: string) => v.split('.')[0];
  assert.equal(major(PLUGIN_API_VERSION), major(packageVersion()));
});

describe('согласованность версий (K-21)', () => {
  test('ST-5001/5: PLUGIN_API_VERSION - чистая x.y.z: разбор диапазонов ядра суффикс не читает, а engines.cyborg плагинов судят по ней', () => {
    assert.ok(parseVersion(PLUGIN_API_VERSION), `«${PLUGIN_API_VERSION}» не читается разбором ядра`);
    assert.match(PLUGIN_API_VERSION, /^\d+\.\d+\.\d+$/);
  });

  test('версия пакета контрактов не ниже версии API: новый контракт повышает пакет, но не API плагина', () => {
    assert.ok(cmp(numbers(packageVersion()), numbers(PLUGIN_API_VERSION)) >= 0, `пакет ${packageVersion()} ниже API ${PLUGIN_API_VERSION}`);
  });

  test('суффикс версии пакета - один из трёх: -dev (линия разработки), -rc.N (кандидат), без суффикса (заморожено)', () => {
    assert.match(packageVersion(), /^\d+\.\d+\.\d+(-dev|-rc\.\d+)?$/);
  });

  test('ST-5001/1: engines.cyborg каждого встроенного плагина, шаблона и проверочного потребителя: допустимый диапазон, принимает API ядра и не выходит за его мажор', () => {
    const manifests = builtInManifests();
    assert.ok(manifests.length >= 20, `нашлось только ${String(manifests.length)} манифестов`);
    const major = numbers(PLUGIN_API_VERSION)[0];
    for (const rel of manifests) {
      const range = (json(rel).engines as { cyborg?: unknown } | undefined)?.cyborg;
      assert.equal(typeof range, 'string', `${rel}: нет engines.cyborg`);
      assert.ok(isValidRange(String(range)), `${rel}: «${String(range)}» ядро не разбирает`);
      assert.ok(satisfies(PLUGIN_API_VERSION, String(range)), `${rel}: «${String(range)}» не принимает API ${PLUGIN_API_VERSION}`);
      assert.ok(allowsMajor(String(range), major), `${rel}: «${String(range)}» не допускает мажор ${String(major)}`);
      assert.ok(!allowsMajor(String(range), major + 1), `${rel}: «${String(range)}» допускает и следующий мажор`);
    }
  });

  test('peer-зависимость на контракты у ядра, адаптера, тест-кита и шаблона принимает версию пакета контрактов', () => {
    for (const rel of ['core/package.json', 'electron/package.json', 'testing/package.json', 'templates/plugin/package.json']) {
      const peers = (json(rel).peerDependencies ?? json(rel).devDependencies) as Record<string, string> | undefined;
      const range = peers?.['@cyborg-harness/contracts'];
      assert.ok(range, `${rel}: нет зависимости от @cyborg-harness/contracts`);
      assert.ok(peerAccepts(range, packageVersion()), `${rel}: «${range}» не принимает ${packageVersion()}`);
    }
  });

  test('эталон снимка есть для версии API, его заголовок называет ту же версию', () => {
    const file = path.join(repo, 'core', 'test', 'api-snapshot', `${PLUGIN_API_VERSION}.txt`);
    assert.ok(existsSync(file), `нет ${file}`);
    assert.match(readFileSync(file, 'utf8'), new RegExp(`^// plugin API ${PLUGIN_API_VERSION.replaceAll('.', '\\.')}\\n`));
  });
});

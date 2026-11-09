import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { memoryStore } from '../../testing/src/memory.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { SectionStore } from '../src/config.ts';
import { load, type Kernel } from '../src/loader.ts';
import { checkPlugin } from '../src/plugin-check.ts';
import { pluginStatuses } from '../src/status.ts';
import { forkHosts } from '../src/transports.ts';

// P-05: плагин из templates/plugin проходит проверку состава и грузится ядром на forkHosts - главная часть и потребитель в разных процессах.
// Свои тесты шаблона (startKernel тест-кита) лежат в templates/plugin/test; здесь - загрузка настоящим процессом хоста, которого в тест-ките нет.
const repo = path.resolve(import.meta.dirname, '..', '..');
const home = path.join(repo, 'templates', 'plugin');
const consumer = path.join(home, 'test', 'consumer');

const read = (dir: string, file: string): unknown => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

async function start(layers: Record<string, Record<string, unknown>> = {}): Promise<Kernel> {
  return load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['example', 'consumer'],
    manifests: [read(home, 'manifest.json'), read(consumer, 'manifest.json')],
    hosts: { provider: ['example'], user: ['consumer'] },
    spawnHost: forkHosts({ silent: true }),
    entry: (m) => pathToFileURL(path.join(m.id === 'example' ? home : consumer, 'index.ts')).href,
    schema: (_manifest, file) => read(home, file),
    config: await SectionStore.open(memoryStore(layers).store, ['user', 'workspace']),
  });
}

describe('шаблон плагина templates/plugin', () => {
  it('checkPlugin: замечаний нет ни как есть, ни как под сборку; прав не просит', async () => {
    for (const bundled of [false, true]) {
      const report = await checkPlugin(home, { bundled, ignore: ['dist'] });
      assert.deepEqual(report.problems, [], `bundled: ${String(bundled)}`);
      assert.equal(report.ok, true);
      assert.equal(report.id, 'example');
      assert.deepEqual(report.permissions, []);
      assert.equal(report.files, 3, 'index.ts, contracts.ts, ui/ui.ts; test/ и результат локальной сборки dist/ в проверку не входят');
    }
  });

  it('на forkHosts: оба плагина активны в разных процессах, команда отвечает, вид объявлен, потребитель зовёт контракт', async () => {
    const k = await start();
    try {
      assert.deepEqual(pluginStatuses(k.journal).map((s) => [s.id, s.state]).sort(), [['consumer', 'active'], ['example', 'active']]);
      assert.notEqual(k.hostOf('example'), k.hostOf('consumer'));
      assert.equal(await k.run('example.hello'), 'привет');
      assert.equal(await k.run('consumer.ask', 'мир'), 'привет, мир');
      assert.ok(k.layout.some((e) => e.pluginId === 'example' && e.kind === 'view' && e.name === 'main' && e.mark === undefined));
      assert.equal(k.keybindings.find((b) => b.command === 'example.hello')?.pluginId, 'example');
    } finally {
      await k.unload();
    }
  });

  it('раздел config проходит схему из каталога плагина: своё значение читается, чужого типа - отказ плагину', async () => {
    const ok = await start({ user: { example: { $version: 1, greeting: 'здравствуйте' } } });
    try {
      assert.equal(await ok.run('consumer.ask', 'мир'), 'здравствуйте, мир');
    } finally {
      await ok.unload();
    }
    const refused = await start({ user: { example: { $version: 1, greeting: 5 } } });
    try {
      assert.ok(!refused.active.includes('example'));
      assert.deepEqual(refused.journal.filter((e) => e.kind === 'config'), [{ pluginId: 'example', kind: 'config', result: { status: 'invalid', errors: ['/greeting: ожидается string, получено integer'] } }]);
    } finally {
      await refused.unload();
    }
  });

  it('предметных имён в шаблоне нет', () => {
    const domain = /session|agent|claude|terminal|tracker|pty|сесси|агент/i;
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(file);
        } else if (domain.test(fs.readFileSync(file, 'utf8'))) found.push(path.relative(home, file));
      }
    };
    walk(home);
    assert.deepEqual(found, []);
  });
});

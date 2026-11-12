import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { inlineHosts } from '@cyborg-harness/core';
import { diagnosticsDir, fileDiagnostics, nodeDiagnosticsFs } from '../src/diagnostics-file.ts';
import { PluginsService, startPlugins } from '../src/plugins.ts';

// K-30: хранение диагностики в адаптере - файлы в userData, окно показывает причину сбоя прошлого запуска, выгрузка из окна.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-diag-'));

function plugin(dir: string, id: string): void {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'manifest.json'), JSON.stringify({ id, version: '1.2.0', engines: { cyborg: '^1' } }));
  fs.writeFileSync(path.join(dir, id, 'index.mjs'), 'export default {}');
}

/** Один запуск службы окна на `userData`; `broken` - плагин `disk` не поднимается. */
async function run(userData: string, broken: boolean) {
  const workspaceFile = path.join(userData, 'workspace.cyborg.json');
  const service = new PluginsService({ changed: () => undefined, alert: () => undefined });
  const diagnostics = fileDiagnostics(userData, workspaceFile, { app: 'Тест 1.0' });
  await service.start({
    userData,
    builtinDir: path.join(userData, 'нет'),
    userPlugins: true,
    spawnHost: inlineHosts(async () => ({
      activate() {
        if (broken) throw new Error('нет диска');
      },
    })),
    log: () => undefined,
    diagnostics,
    versions: { app: 'Тест 1.0', core: '0.1.0' },
  });
  return { service, diagnostics };
}

test('ST-4003/4, ST-4003/5: служба окна: после перезапуска причина сбоя прошлого запуска видна у плагина, а состояние плагина - из текущего запуска (FR-CH-4013, 4014)', async () => {
  const userData = tmp();
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['disk'] } }));
  plugin(path.join(userData, 'plugins'), 'disk');

  const first = await run(userData, true);
  const before = first.service.snapshot();
  assert.equal(before.plugins[0]?.state, 'stopped');
  assert.equal(before.plugins[0].previousFailure, undefined, 'в первом запуске прошлого нет');
  await first.service.unload();

  const second = await run(userData, false);
  try {
    const snapshot = second.service.snapshot();
    const row = snapshot.plugins.find((p) => p.id === 'disk');
    assert.equal(row?.state, 'active', 'прошлый `failed` состояния не меняет');
    assert.equal(row.reason, undefined);
    assert.match(row.previousFailure?.text ?? '', /не поднялся в хосте .*: нет диска/);
    assert.ok((row.previousFailure?.at ?? 0) > 0);
    assert.equal(snapshot.journal.some((l) => l.text.includes('нет диска')), false, 'журнал текущего запуска записей прошлого не несёт');
    assert.ok(snapshot.diagnostics !== undefined && snapshot.diagnostics.files >= 1 && snapshot.diagnostics.previousRunAt !== undefined);
    assert.equal(snapshot.diagnostics.problem, undefined);
  } finally {
    await second.service.unload();
  }
});

test('ST-4004/1: служба окна: выгрузка пишет один текстовый файл туда, куда назвал человек, с версиями, состоянием и записью о сбое; ошибки пути и отсутствие хранения - отказ с текстом (FR-CH-4015, 4016)', async () => {
  const userData = tmp();
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['disk'] } }));
  plugin(path.join(userData, 'plugins'), 'disk');
  const { service } = await run(userData, true);
  try {
    const target = path.join(tmp(), 'выгрузка.txt');
    const reply = await service.exportDiagnostics(target);
    assert.deepEqual(reply, { value: { file: target, bytes: fs.statSync(target).size } });
    const text = fs.readFileSync(target, 'utf8');
    assert.match(text, /^Диагностика Cyborg Harness\n/);
    assert.ok(text.includes('Приложение: Тест 1.0') && text.includes('пакет 0.1.0'));
    assert.match(text, /\n {2}disk 1\.2\.0 - выключен/);
    assert.match(text, /журнал error disk: не поднялся в хосте .*: нет диска/);
    assert.equal(fs.statSync(target).mode & 0o077, 0, 'файл только для владельца');

    assert.deepEqual(await service.exportDiagnostics(undefined), { error: 'выгрузка: нужен путь файла' });
    const failed = await service.exportDiagnostics(path.join(target, 'нет', 'такого'));
    assert.match(failed.error ?? '', /^выгрузка не записана: /);
  } finally {
    await service.unload();
  }
  const bare = new PluginsService({ changed: () => undefined, alert: () => undefined });
  assert.deepEqual(await bare.exportDiagnostics('/tmp/x'), { error: 'хранение диагностики не включено' });
});

// Канал выгрузки зовёт диалог Electron, которого в Node нет: имя по умолчанию берётся из исходника и вычисляется.
test('ST-4004/1: выгрузка: имя файла по умолчанию в диалоге сохранения - cyborg-diagnostics-<время>.txt, без двоеточий и точек во времени', () => {
  const code = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'channels.ts'), 'utf8');
  const handler = /windowChannel\('diagnostics:export', async \(\) => \{\n\s*const file = await choose\((`[^`]*`)\);/.exec(code);
  assert.ok(handler?.[1], 'канал diagnostics:export предлагает имя шаблоном');
  const name: unknown = vm.runInNewContext(handler[1]);
  assert.equal(typeof name, 'string');
  assert.match(name as string, /^cyborg-diagnostics-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.txt$/);
});

test('ST-4004/3: выгрузка в адаптере: хранение, служба окна и канал выгрузки не импортируют сеть и не вызывают fetch (FR-CH-4016, осмотр)', () => {
  const src = path.resolve(import.meta.dirname, '..', 'src');
  for (const file of ['diagnostics-file.ts', 'plugins.ts', 'channels.ts']) {
    const code = fs.readFileSync(path.join(src, file), 'utf8');
    assert.ok(!/from 'node:(?:net|http|https|http2|dns|tls|dgram)'/.test(code), `${file}: сетевой модуль Node`);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(code), `${file}: сетевой вызов`);
    const fromElectron = [...code.matchAll(/import\s*\{([^}]*)\}\s*from 'electron'/g)].flatMap((m) => (m[1] ?? '').split(',').map((n) => n.trim().replace(/^type\s+/, '')));
    assert.ok(!fromElectron.some((n) => n === 'net' || n.startsWith('net ')), `${file}: net из electron`);
  }
});

test('старт: с diagnostics записи ядра идут в файл userData, а onTrace приложения тоже получает записи', async () => {
  const userData = tmp();
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['greeter'] } }));
  const dir = path.join(userData, 'plugins');
  plugin(dir, 'greeter');
  fs.writeFileSync(path.join(dir, 'greeter', 'manifest.json'), JSON.stringify({ id: 'greeter', version: '1.0.0', engines: { cyborg: '^1' }, commands: ['greeter.hi'] }));
  const diagnostics = fileDiagnostics(userData, path.join(userData, 'workspace.cyborg.json'));
  const seen: string[] = [];
  const kernel = await startPlugins({
    userData,
    builtinDir: path.join(userData, 'нет'),
    userPlugins: true,
    spawnHost: inlineHosts(async () => ({ activate: (ctx) => void ctx.commands.register('greeter.hi', () => 'привет') })),
    log: () => undefined,
    diagnostics,
    onTrace: (r) => void seen.push(r.kind),
  });
  assert.equal(await kernel.run('greeter.hi'), 'привет');
  await kernel.unload();
  assert.deepEqual(seen, ['operation']);
  const files = fs.readdirSync(diagnosticsDir(userData, path.join(userData, 'workspace.cyborg.json')));
  assert.deepEqual(files, ['diagnostics.log']);
  const lines = fs.readFileSync(path.join(diagnosticsDir(userData, path.join(userData, 'workspace.cyborg.json')), 'diagnostics.log'), 'utf8').trim().split('\n');
  const kinds = lines.map((l) => (JSON.parse(l) as { src: string }).src);
  assert.ok(kinds.includes('run') && kinds.includes('journal') && kinds.includes('trace'), kinds.join(','));
});

test('ST-4003/1: файлы на диске: ротация держит число и размер, права владельца, каталог у каждого воркспейса свой', () => {
  const userData = tmp();
  const a = diagnosticsDir(userData, path.join(userData, 'a.cyborg.json'));
  const b = diagnosticsDir(userData, path.join(userData, 'b.cyborg.json'));
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), path.join(userData, 'diagnostics'));
  const d = fileDiagnostics(userData, path.join(userData, 'a.cyborg.json'), { fileBytes: 3000, files: 3 });
  for (let i = 0; i < 400; i++) d.sinks.onLog('p', `строка ${String(i)} ${'я'.repeat(30)}`, 'error');
  d.close();
  const names = fs.readdirSync(a).sort();
  assert.deepEqual(names, ['diagnostics.1.log', 'diagnostics.2.log', 'diagnostics.log']);
  for (const name of names) {
    const stat = fs.statSync(path.join(a, name));
    assert.ok(stat.size <= 3000, `${name}: ${String(stat.size)} Б`);
    assert.equal(stat.mode & 0o077, 0);
  }
  assert.equal(fs.existsSync(b), false, 'соседний воркспейс не затронут');
  const fsys = nodeDiagnosticsFs(a);
  assert.equal(fsys.size('нет-такого.log'), 0);
  assert.doesNotThrow(() => fsys.remove('нет-такого.log'));
  assert.deepEqual(nodeDiagnosticsFs(path.join(userData, 'пусто')).list(), []);
});

test('ST-4003/3: отказ диска в адаптере: каталог недоступен для записи - ядро поднимается, операции отвечают, причина названа в снимке окна', async () => {
  const userData = tmp();
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['disk'] } }));
  plugin(path.join(userData, 'plugins'), 'disk');
  // На месте каталога диагностики лежит файл: mkdir/append падают так же, как при отказе прав или места.
  fs.writeFileSync(path.join(userData, 'diagnostics'), 'не каталог');
  const { service } = await run(userData, true);
  try {
    const snapshot = service.snapshot();
    assert.equal(snapshot.phase, 'ready');
    assert.equal(snapshot.plugins[0]?.state, 'stopped');
    assert.match(snapshot.diagnostics?.problem ?? '', /^E/);
  } finally {
    await service.unload();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inlineHosts, type TraceRecord } from '@cyborg-harness/core';
import { fileDiagnostics } from '../src/diagnostics-file.ts';
import { PluginsService, startPlugins, TRACE_ARGS_FLAG } from '../src/plugins.ts';

// K-33 (#224): флаг запуска `--trace-args` - только командная строка (StartOptions.traceArgs), виден в снимке окна и в журнале, выгрузка предупреждает.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-trace-args-'));

/** userData с плагином `greeter` (команда `greeter.hi`); `settings` - что лежит в cyborg.json пользователя и в файле воркспейса. */
function setup(settings: Record<string, unknown> = {}): { userData: string; workspace: string } {
  const userData = tmp();
  const workspace = path.join(userData, 'workspace.cyborg.json');
  const dir = path.join(userData, 'plugins', 'greeter');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'greeter', version: '1.0.0', engines: { cyborg: '^1' }, commands: { 'greeter.hi': { args: ['any'] } } }));
  fs.writeFileSync(path.join(dir, 'index.mjs'), 'export default {}');
  const enabled = { plugins: { enabled: ['greeter'] } };
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ ...enabled, ...settings, plugins: { ...enabled.plugins, ...(settings.plugins as object | undefined) } }));
  fs.writeFileSync(workspace, JSON.stringify({ ...enabled, ...settings, plugins: { ...enabled.plugins, ...(settings.plugins as object | undefined) } }));
  return { userData, workspace };
}

const host = inlineHosts(async () => ({ activate: (ctx) => void ctx.commands.register('greeter.hi', (name) => `привет, ${String(name)}`) }));
const operations = (records: readonly TraceRecord[]) => records.filter((r) => r.kind === 'operation');

test('флаг запуска назван --trace-args', () => {
  assert.equal(TRACE_ARGS_FLAG, '--trace-args');
});

test('ST-4001/5: без StartOptions.traceArgs записи не несут аргументов, даже если файлы пользователя и воркспейса просят их любыми ключами (критерий приёмки K-33)', async () => {
  const keys = { traceArgs: true, 'trace-args': true, '--trace-args': true, diagnostics: { traceArgs: true }, trace: { args: true }, plugins: { traceArgs: true, 'trace-args': true } };
  const { userData } = setup(keys);
  const records: TraceRecord[] = [];
  const kernel = await startPlugins({ userData, builtinDir: path.join(userData, 'нет'), userPlugins: true, spawnHost: host, log: () => undefined, onTrace: (r) => void records.push(r) });
  assert.equal(await kernel.run('greeter.hi', 'Мир'), 'привет, Мир');
  await kernel.unload();
  const ops = operations(records);
  assert.ok(ops.length > 0);
  for (const op of ops) assert.ok(!('args' in op), 'аргументы без флага командной строки');
  assert.ok(!kernel.journal.some((e) => e.kind === 'trace-args'));
});

test('со StartOptions.traceArgs запись команды несёт аргументы, в журнале ядра запись trace-args (K-33)', async () => {
  const { userData } = setup();
  const records: TraceRecord[] = [];
  const kernel = await startPlugins({ userData, builtinDir: path.join(userData, 'нет'), userPlugins: true, spawnHost: host, log: () => undefined, traceArgs: true, onTrace: (r) => void records.push(r) });
  await kernel.run('greeter.hi', 'Мир');
  await kernel.unload();
  const op = operations(records).find((r) => r.target === 'command:greeter.hi');
  assert.equal(op?.args, '["Мир"]');
  assert.ok(kernel.journal.some((e) => e.kind === 'trace-args'));
});

test('окно: снимок называет включённый флаг, журнал окна несёт строку-предупреждение; без флага ни того, ни другого (критерий приёмки K-33)', async () => {
  const { userData, workspace } = setup();
  const service = new PluginsService({ changed: () => undefined, alert: () => undefined });
  await service.start({ userData, builtinDir: path.join(userData, 'нет'), userPlugins: true, spawnHost: host, log: () => undefined, traceArgs: true, diagnostics: fileDiagnostics(userData, workspace) });
  try {
    const snapshot = service.snapshot();
    assert.equal(snapshot.traceArgs, true);
    const line = snapshot.journal.find((l) => l.text.includes('--trace-args'));
    assert.ok(line, 'строки журнала о флаге нет');
    assert.deepEqual([line.subject, line.level, line.plugins], ['трасса', 'warn', []]);
  } finally {
    await service.unload();
  }

  const quiet = setup();
  const off = new PluginsService({ changed: () => undefined, alert: () => undefined });
  await off.start({ userData: quiet.userData, builtinDir: path.join(quiet.userData, 'нет'), userPlugins: true, spawnHost: host, log: () => undefined, diagnostics: fileDiagnostics(quiet.userData, quiet.workspace) });
  try {
    assert.equal(off.snapshot().traceArgs, false);
    assert.ok(!off.snapshot().journal.some((l) => l.text.includes('--trace-args')));
  } finally {
    await off.unload();
  }
});

test('флаг без приёмника трассы ничего не включает: снимок показывает false, чтобы плашка не обещала записи, которых нет (K-33)', async () => {
  const { userData } = setup();
  const service = new PluginsService({ changed: () => undefined, alert: () => undefined });
  await service.start({ userData, builtinDir: path.join(userData, 'нет'), userPlugins: true, spawnHost: host, log: () => undefined, traceArgs: true });
  try {
    assert.equal(service.snapshot().traceArgs, false);
  } finally {
    await service.unload();
  }
});

test('выгрузка из окна с флагом предупреждает, что в файле есть аргументы, и несёт аргументы команды (K-33, K-30)', async () => {
  const { userData, workspace } = setup();
  const service = new PluginsService({ changed: () => undefined, alert: () => undefined });
  await service.start({ userData, builtinDir: path.join(userData, 'нет'), userPlugins: true, spawnHost: host, log: () => undefined, traceArgs: true, diagnostics: fileDiagnostics(userData, workspace) });
  try {
    await service.run('greeter.hi', ['Мир']);
    const target = path.join(tmp(), 'выгрузка.txt');
    const reply = await service.exportDiagnostics(target);
    assert.equal(reply.error, undefined);
    const text = fs.readFileSync(target, 'utf8');
    assert.ok(text.includes('ВНИМАНИЕ: в записях есть аргументы операций'));
    assert.ok(text.includes('аргументы: ["Мир"]'));
  } finally {
    await service.unload();
  }
});

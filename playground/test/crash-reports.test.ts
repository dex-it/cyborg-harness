import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// #185: smoke и замер шлюза считают падением Electron сигнал завершения и отчёт macOS о нём (playground/scripts/crash-reports.mjs).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-crash-reports-'));
process.env.HOME = home;
const reports = path.join(home, 'Library', 'Logs', 'DiagnosticReports');
const { crashOf, crashReportsOf, CRASH_SIGNALS } = (await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'scripts', 'crash-reports.mjs')).href)) as {
  crashOf: (child: { pid: number; signalCode: string | null }, since: number) => Promise<string | undefined>;
  crashReportsOf: (pid: number, since: number) => string[];
  CRASH_SIGNALS: Set<string>;
};
const darwin = process.platform === 'darwin';

const ips = (name: string, body: object, mtime?: Date) => {
  fs.mkdirSync(reports, { recursive: true });
  const file = path.join(reports, name);
  fs.writeFileSync(file, `${JSON.stringify({ app_name: 'Electron' })}\n${JSON.stringify(body)}`);
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
};

test('сигналы падения названы, а просьбы завершиться (SIGTERM, SIGKILL от теста) падением не считаются', () => {
  for (const s of ['SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGTRAP', 'SIGFPE']) assert.ok(CRASH_SIGNALS.has(s), s);
  for (const s of ['SIGTERM', 'SIGKILL', 'SIGINT']) assert.ok(!CRASH_SIGNALS.has(s), s);
});

test('процесс, завершённый SIGABRT, - падение сразу, без ожидания отчёта', async () => {
  const started = Date.now();
  assert.match((await crashOf({ pid: 1, signalCode: 'SIGABRT' }, started)) ?? '', /SIGABRT/);
  assert.ok(Date.now() - started < 1000);
});

test('чистый выход (код 0 или SIGTERM от теста) падением не считается', async () => {
  assert.equal(await crashOf({ pid: 2_000_000_001, signalCode: null }, Date.now()), undefined);
  assert.equal(await crashOf({ pid: 2_000_000_001, signalCode: 'SIGTERM' }, Date.now()), undefined);
});

test('отчёт macOS: свой процесс по pid Electron или его обёртки находится, чужой, старый и не отчёт - нет', { skip: !darwin && 'отчёты о падении пишет только macOS' }, async () => {
  const since = Date.now() - 1000;
  const own = ips('Electron-2026-11-10-100000.ips', { pid: 4242, parentPid: 4241 });
  ips('Electron-2026-11-10-100001.ips', { pid: 9, parentPid: 8 });
  ips('Electron-2026-11-10-100002.ips', { pid: 4242, parentPid: 4241 }, new Date(since - 60_000));
  ips('Chrome-2026-11-10-100003.ips', { pid: 4242, parentPid: 4241 });
  fs.writeFileSync(path.join(reports, 'Electron-2026-11-10-100004.ips'), 'не JSON');
  assert.deepEqual(crashReportsOf(4242, since), [own], 'по pid самого Electron');
  assert.deepEqual(crashReportsOf(4241, since), [own], 'по pid обёртки node_modules/.bin/electron');
  assert.deepEqual(crashReportsOf(7, since), []);
  assert.match((await crashOf({ pid: 4241, signalCode: 'SIGTERM' }, since)) ?? '', /отчёт о падении/);
});

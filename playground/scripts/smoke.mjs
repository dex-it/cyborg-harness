// Дымовой тест собранного playground по DevTools Protocol; нужен дисплей (на Linux - xvfb-run ... --no-sandbox).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..', '..');
const electronArgs = process.argv.slice(2);
const TIMEOUT_MS = 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (text) => console.log(`smoke: ${text}`);
const userData = mkdtempSync(join(tmpdir(), 'cyborg-playground-smoke-'));

async function waitFor(what, probe, timeout = TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`не дождались: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

const app = spawn(join(repo, 'node_modules', '.bin', 'electron'), [repo, `--user-data-dir=${userData}`, '--remote-debugging-port=0', ...electronArgs], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
app.stderr.on('data', (d) => (stderr += d));
let socket;

async function main() {
  const port = await waitFor('порт DevTools', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)?.[1]);
  const page = await waitFor('окно', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'));
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    socket.onopen = r;
    socket.onerror = () => j(new Error('нет соединения с DevTools'));
  });
  let seq = 0;
  const pending = new Map();
  socket.onmessage = (m) => {
    const d = JSON.parse(m.data);
    pending.get(d.id)?.(d);
  };
  const ev = (expression) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, (d) => (d.result?.exceptionDetails ? rej(new Error(d.result.exceptionDetails.text)) : res(d.result?.result?.value)));
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  const text = (selector) => ev(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
  const state = (id) => ev(`document.querySelector('#plugins-list [data-plugin=${JSON.stringify(id)}]')?.dataset.state ?? ''`);
  const button = (id, label) =>
    ev(`(() => {
      const b = [...document.querySelectorAll('#plugins-list [data-plugin=${JSON.stringify(id)}] button')].find((x) => x.textContent === ${JSON.stringify(label)});
      if (b) b.click();
      return !!b;
    })()`);
  const lines = () => stderr.split('\n').filter((l) => l.startsWith('[plugins]'));

  await waitFor('echo и probe работают, flaky выключен с причиной', async () =>
    (await state('echo')) === 'active' &&
    (await state('probe')) === 'active' &&
    (await state('flaky')) === 'stopped' &&
    /всегда падает/.test(await text('#plugins-list [data-plugin="flaky"] .plugin-reason')),
  );
  const answer = lines().find((l) => l.startsWith('[plugins] probe: ответ:')) ?? '';
  const [, echoPid, probePid] = /привет из (\d+), probe в (\d+)/.exec(answer) ?? [];
  assert.ok(echoPid && probePid && echoPid !== probePid, `echo и probe не в разных процессах:\n${lines().join('\n')}`);
  log('демо-плагины в разных хостах utilityProcess, вызов между хостами');

  process.kill(Number(echoPid), 'SIGKILL');
  await waitFor('хост a упал и поднялся, probe увидел возврат echo', () => lines().some((l) => l === '[plugins] probe: echo вернулся'));
  await waitFor('echo снова работает', async () => (await state('echo')) === 'active');
  assert.match(await text('#plugins-journal'), /хост a упал/, 'в журнале нет падения хоста a');
  log('падение хоста: перезапуск, возврат поставщика, запись в журнале');

  assert.equal(await button('probe', 'Журнал'), true, 'у probe нет кнопки «Журнал»');
  assert.equal(await text('#plugins-journal-title'), 'Журнал: probe');
  assert.doesNotMatch(await text('#plugins-journal'), /\bflaky\b/, 'журнал probe показал чужие записи');
  assert.match(await text('#plugins-journal'), /хост a упал/, 'журнал probe не показал падение его поставщика');
  assert.equal(await button('flaky', 'Включить снова'), true, 'у выключенного flaky нет «Включить снова»');
  await waitFor('flaky включён снова', async () => (await state('flaky')) === 'active');
  log('окно: заглушка с причиной, журнал плагина, «Включить снова»');
}

let failed = false;
try {
  await main();
  log('все проверки пройдены');
} catch (error) {
  failed = true;
  console.error(`smoke: ОШИБКА: ${error.stack ?? error}\n${stderr}`);
} finally {
  socket?.close();
  app.kill('SIGTERM');
  await Promise.race([new Promise((r) => app.once('exit', r)), sleep(8000)]);
  if (app.exitCode === null) app.kill('SIGKILL');
  rmSync(userData, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { PtyProcess } from '@cyborg-harness/core/pty-host';
import { nodePtyBackend, type NodePtyModule } from '../src/pty-backend.ts';

// #185: `node-pty` доставляет выход процесса из своего потока. Выход, не дошедший до JS к очистке окружения Node, роняет главный процесс Electron SIGABRT
// (окно падения macOS). Бэкенд помнит живые процессы и в `drain()` дожидается их выхода.

type Fake = PtyProcess & { signals: string[]; exit(): void };
const OPTIONS = { name: 'xterm-256color', env: {}, cols: 80, rows: 24 };

/** Подделка модуля `node-pty`: выход приходит не сразу после сигнала, как у настоящего процесса (поток ожидания доставляет его позже). */
function fakeModule(behaviour: { exitsOn: 'SIGHUP' | 'SIGKILL'; delay: number }) {
  const procs: Fake[] = [];
  const mod: NodePtyModule = {
    spawn() {
      const exits = new Set<() => void>();
      let done = false;
      const proc: Fake = {
        pid: 4000 + procs.length,
        signals: [],
        onData: () => ({ dispose() {} }),
        onExit: (l) => (exits.add(() => l({ exitCode: 0 })), { dispose() {} }),
        write() {},
        resize() {},
        kill(signal = 'SIGHUP') {
          proc.signals.push(signal);
          if (signal === behaviour.exitsOn) setTimeout(() => proc.exit(), behaviour.delay);
        },
        exit() {
          if (done) return;
          done = true;
          for (const l of exits) l();
        },
      };
      procs.push(proc);
      return proc;
    },
  };
  return { mod, procs };
}

// Подделке не нужна группа процессов: настоящий killGroup послал бы сигнал чужому pid.
const identity = (proc: PtyProcess) => proc;

test('модуль node-pty не загружается, пока не нужен: в главном процессе с pty-хостом pty.node не нужен совсем', async () => {
  let loads = 0;
  const { mod } = fakeModule({ exitsOn: 'SIGHUP', delay: 1 });
  const backend = nodePtyBackend({ load: () => (loads++, Promise.resolve(mod)), group: identity });
  assert.equal(loads, 0, 'модуль загружен при создании бэкенда');
  await backend.drain?.();
  assert.equal(loads, 0, 'drain без процессов загрузил модуль');
  await backend.spawn('sh', [], OPTIONS);
  await backend.spawn('sh', [], OPTIONS);
  assert.equal(loads, 1, 'модуль загружается один раз на бэкенд');
});

test('загрузка модуля не удалась - spawn отвечает ошибкой, следующий spawn пробует заново', async () => {
  const { mod } = fakeModule({ exitsOn: 'SIGHUP', delay: 1 });
  let attempt = 0;
  const backend = nodePtyBackend({ load: () => (++attempt === 1 ? Promise.reject(new Error('нет pty.node')) : Promise.resolve(mod)), group: identity });
  await assert.rejects(Promise.resolve(backend.spawn('sh', [], OPTIONS)), /нет pty\.node/);
  assert.ok(await backend.spawn('sh', [], OPTIONS));
});

test('drain ждёт выход каждого убитого процесса: к его возврату все onExit доставлены', async () => {
  const { mod, procs } = fakeModule({ exitsOn: 'SIGHUP', delay: 30 });
  const backend = nodePtyBackend({ load: () => Promise.resolve(mod), group: identity });
  const delivered: number[] = [];
  for (let i = 0; i < 3; i++) {
    const proc = await backend.spawn('sh', [], OPTIONS);
    proc.onExit(() => void delivered.push(i));
  }
  for (const p of procs) p.kill();
  await backend.drain?.();
  assert.deepEqual(delivered.sort(), [0, 1, 2], 'drain вернулся раньше выходов');
  assert.deepEqual(procs.map((p) => p.signals), [['SIGHUP'], ['SIGHUP'], ['SIGHUP']], 'вышедшим сам по SIGHUP процессам послан лишний сигнал');
});

test('drain добивает SIGKILL процесс, не вышедший по сроку, и ждёт его выход; вышедший сам SIGKILL не получает', async () => {
  const { mod, procs } = fakeModule({ exitsOn: 'SIGKILL', delay: 10 });
  const backend = nodePtyBackend({ load: () => Promise.resolve(mod), group: identity, graceMs: 40 });
  const delivered: string[] = [];
  const stubborn = await backend.spawn('sh', [], OPTIONS);
  const polite = await backend.spawn('sh', [], OPTIONS);
  stubborn.onExit(() => void delivered.push('stubborn'));
  polite.onExit(() => void delivered.push('polite'));
  stubborn.kill();
  procs[1]?.exit();
  await backend.drain?.();
  assert.deepEqual(procs.map((p) => p.signals), [['SIGHUP', 'SIGKILL'], []]);
  assert.deepEqual(delivered, ['polite', 'stubborn']);
});

test('drain не висит вечно: процесс, не вышедший и после SIGKILL, отпускается по сроку', async () => {
  const { mod } = fakeModule({ exitsOn: 'SIGHUP', delay: 1 });
  // Выход не придёт никогда: подделка отвечает только на SIGHUP, а процесс никто не кончает.
  const backend = nodePtyBackend({ load: () => Promise.resolve(mod), group: identity, graceMs: 20, killWaitMs: 20 });
  await backend.spawn('sh', [], OPTIONS);
  const started = Date.now();
  await backend.drain?.();
  assert.ok(Date.now() - started < 1000, 'drain ждал бесконечно');
});

test('главный процесс не импортирует node-pty статически: os-env.ts берёт его только через бэкенд (ленивая загрузка, #185)', () => {
  const src = path.resolve(import.meta.dirname, '..', 'src');
  for (const file of ['os-env.ts']) {
    const text = fs.readFileSync(path.join(src, file), 'utf8');
    assert.doesNotMatch(text, /from\s+'node-pty'/, `${file}: статический импорт node-pty грузит pty.node в главный процесс`);
  }
});

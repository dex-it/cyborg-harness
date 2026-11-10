import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { runPtyHost, type PtyBackend, type PtyProcess } from '@cyborg-harness/core/pty-host';
import { nodePtyBackend } from '../src/pty-backend.ts';
import { waitFor } from './wait-for.ts';

// #167: настоящий node-pty и pty, чья программа не читает stdin. node-pty очередь записи наружу не отдаёт, поэтому pty-хост держит потолок невычитанного
// сам: принятое без единого байта вывода программы считается непрочитанным, и сверх `ptyQueue` ввод отклоняется. Сообщения - формат `Endpoint` ядра.

/** Клиент pty-хоста по порту: запрос с ответом по номеру, уведомления хоста складываются в `notes`. */
function client(backend: PtyBackend) {
  const { port1, port2 } = new MessageChannel();
  port1.unref();
  port2.unref();
  const pending = new Map<number, (m: { ok: boolean; v?: unknown; e?: { code?: string; message?: string } }) => void>();
  const notes: { m: string; p: { key?: string; data?: string; exit?: unknown } }[] = [];
  port2.on('message', (m: { t: string; id?: number; m?: string; p?: never; ok?: boolean; v?: unknown; e?: never }) => {
    if (m.t === 'res' && m.id !== undefined) pending.get(m.id)?.({ ok: m.ok === true, v: m.v, e: m.e });
    else if (m.t === 'note') notes.push({ m: m.m ?? '', p: m.p ?? {} });
  });
  port2.unref();
  let next = 1;
  const request = (method: string, params: unknown) =>
    new Promise<{ ok: boolean; v?: unknown; e?: { code?: string; message?: string } }>((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      port2.postMessage({ t: 'req', id, m: method, p: params });
    });
  const host = runPtyHost(
    { post: (m) => port1.postMessage(m), onMessage: (l) => port1.on('message', (m: unknown) => l(m, undefined)) },
    backend,
  );
  return { request, notes, host, stop: () => (host.dispose(), port1.close(), port2.close()) };
}

/** Бэкенд с учётом: сколько байт хост отдал процессу (то, что node-pty держит в своей очереди, пока программа не читает). */
function counting(inner: PtyBackend) {
  const state = { passed: 0 };
  const backend: PtyBackend = {
    async spawn(file, args, options) {
      const proc = await inner.spawn(file, args, options);
      const wrapped: PtyProcess = {
        pid: proc.pid,
        onData: (l) => proc.onData(l),
        onExit: (l) => proc.onExit(l),
        write: (data) => {
          state.passed += Buffer.byteLength(data);
          proc.write(data);
        },
        resize: (c, r) => proc.resize(c, r),
        kill: (s) => proc.kill(s),
      };
      return wrapped;
    },
    ...(inner.drain && { drain: () => inner.drain!() }),
  };
  return { backend, state };
}

const QUEUE = 256 * 1024;
const CHUNK = 64 * 1024;

test('настоящий pty, чья программа не читает stdin: после потолка write отказывает Invalid, процессу уходит не больше потолка; вывод программы снимает отказ (#167)', { skip: process.platform === 'win32' && 'sh и stty' }, async (t) => {
  const { backend, state } = counting(nodePtyBackend());
  const c = client(backend);
  t.after(async () => {
    await c.request('endAll', null);
    c.stop();
  });
  assert.equal((await c.request('init', { ptyInput: 1024 * 1024, ptyInputBurst: 1 << 30, ptyInputRate: 1 << 30, ptyQueue: QUEUE, ptyFlushMs: 0, ptyFlushChars: 1024, backlog: 4096 })).ok, true);
  // Сырой режим без эха: программа ни читает ввод, ни выводит его; USR1 заставляет её вывести слово - признак жизни.
  const script = 'stty raw -echo; trap "echo alive" USR1; echo ready; while :; do sleep 0.05; done';
  const spawned = await c.request('spawn', { key: 'k', file: '/bin/sh', args: ['-c', script], options: { name: 'xterm-256color', env: { PATH: '/usr/bin:/bin' }, cols: 80, rows: 24 } });
  assert.equal(spawned.ok, true, JSON.stringify(spawned));
  const pid = (spawned.v as { pid: number }).pid;
  const heard = () => c.notes.filter((n) => n.m === 'data').map((n) => n.p.data ?? '').join('');
  await waitFor('программа готова', () => heard().includes('ready'));

  const chunk = 'x'.repeat(CHUNK);
  const replies: string[] = [];
  for (let i = 0; i < 8; i++) {
    const r = await c.request('write', { key: 'k', data: chunk });
    replies.push(r.ok ? 'ok' : (r.e?.code ?? '?'));
  }
  assert.deepEqual(replies, [...Array<string>(QUEUE / CHUNK).fill('ok'), ...Array<string>(8 - QUEUE / CHUNK).fill('Invalid')]);
  assert.equal(state.passed, QUEUE, 'node-pty получил ровно потолок, остальное хост не принял');
  const refused = await c.request('write', { key: 'k', data: 'y' });
  assert.match(refused.e?.message ?? '', /не читает ввод/);
  assert.equal(state.passed, QUEUE, 'отказ в очередь не попал');

  process.kill(pid, 'SIGUSR1');
  await waitFor('программа подала признак жизни', () => heard().includes('alive'));
  assert.equal((await c.request('write', { key: 'k', data: chunk })).ok, true, 'вывод программы снял отказ');
  assert.equal(state.passed, QUEUE + CHUNK);
});

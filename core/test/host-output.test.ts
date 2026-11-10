import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { captureOutput, type OutputNote, type OutStream } from '../src/host-output.ts';
import { load } from '../src/loader.ts';
import { forkHosts } from '../src/transports.ts';

// K-29 (FR-CH-4010): вывод процесса хоста разбирается по плагину, чей код выполнялся; нет плагина - строка хоста (pluginId '').

function fakeStream(): OutStream & { readonly written: string[] } {
  const written: string[] = [];
  return {
    written,
    write: (chunk) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    },
  };
}

function rig(current: () => string | undefined = () => undefined, send?: (note: OutputNote) => void) {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const notes: OutputNote[] = [];
  const warned: unknown[][] = [];
  // Консоль Node пишет в stderr и для warn, и для error: сама по себе fake-консоль отличие и воспроизводит.
  const console = {
    warn: (...args: unknown[]) => {
      warned.push(args);
      stderr.write(`${args.join(' ')}\n`);
    },
  };
  captureOutput({ stdout, stderr }, console, current, send ?? ((note) => void notes.push(note)));
  return { stdout, stderr, notes, console, warned };
}

test('вывод хоста: строки stdout и stderr идут ядру с плагином, чей код выполняется, и уровнем потока', () => {
  let who: string | undefined = 'alice';
  const { stdout, stderr, notes } = rig(() => who);
  stdout.write('привет от alice\n');
  who = 'bob';
  stdout.write('первая\nвторая\n');
  stderr.write('беда у bob\n');
  assert.deepEqual(notes, [
    { pluginId: 'alice', level: 'info', text: 'привет от alice' },
    { pluginId: 'bob', level: 'info', text: 'первая' },
    { pluginId: 'bob', level: 'info', text: 'вторая' },
    { pluginId: 'bob', level: 'error', text: 'беда у bob' },
  ]);
});

test('вывод хоста: плагин не определён - строка хоста (pluginId пустой)', () => {
  const { stdout, notes } = rig(() => undefined);
  stdout.write('сам хост\n');
  assert.deepEqual(notes, [{ pluginId: '', level: 'info', text: 'сам хост' }]);
});

test('вывод хоста: console.warn - уровень warn, а не error; после него stderr снова error', () => {
  const { stderr, console, notes } = rig(() => 'alice');
  console.warn('осторожно');
  stderr.write('ошибка\n');
  assert.deepEqual(notes.map((n) => [n.level, n.text]), [['warn', 'осторожно'], ['error', 'ошибка']]);
});

test('вывод хоста: байты, CRLF, пустые строки, запись без перевода строки, обратный вызов записи', async () => {
  const { stdout, notes } = rig(() => 'alice');
  let called = 0;
  const done = () => {
    called++;
  };
  assert.equal(stdout.write(Buffer.from('байты\r\n\r\nсо звёздочкой я\n')), true);
  assert.equal(stdout.write('без перевода строки', done), true);
  assert.equal(stdout.write('кодировка\n', 'utf8', done), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(notes.map((n) => n.text), ['байты', 'со звёздочкой я', 'без перевода строки', 'кодировка']);
  assert.equal(called, 2, 'обратный вызов write не вызван');
});

test('вывод хоста: канал с ядром закрыт - строка уходит в настоящий поток, а не теряется', () => {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const before: unknown = Object.getOwnPropertyDescriptor(stdout, 'write')?.value;
  captureOutput({ stdout, stderr }, { warn: () => undefined }, () => 'alice', () => {
    throw new Error('канал закрыт');
  });
  assert.notEqual(Object.getOwnPropertyDescriptor(stdout, 'write')?.value, before);
  stdout.write('последние слова\n');
  assert.deepEqual(stdout.written, ['последние слова\n']);
});

// Настоящий процесс хоста: два плагина одного хоста, их console.log, console.warn и stderr приходят в onLog по плагинам.
test('вывод хоста: console.log двух плагинов одного хоста разобран по плагинам, в том числе из таймера и продолжения', async () => {
  const lines: string[] = [];
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['p1', 'p2'],
    manifests: ['p1', 'p2'].map((id) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, commands: { [`${id}.say`]: { args: ['string'] }, [`${id}.warn`]: {}, [`${id}.later`]: {} } })),
    hosts: { shared: ['p1', 'p2'] },
    bundled: ['p1', 'p2'],
    spawnHost: forkHosts({ silent: true }),
    entry: () => new URL('./fixtures/talker.ts', import.meta.url).href,
    onLog: (id, message, level) => void lines.push(`${id} [${level}] ${message}`),
  });
  try {
    assert.equal(k.hostOf('p1'), k.hostOf('p2'), 'плагины должны быть в одном хосте');
    await k.run('p1.say', 'раз');
    await k.run('p2.say', 'два');
    await k.run('p1.later');
    await k.run('p2.warn');
    await k.run('p2.later');
    for (const end = Date.now() + 3000; lines.length < 10 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(
      lines.toSorted(),
      [
        'p1 [info] p1: из продолжения',
        'p1 [info] p1: из таймера',
        'p1 [info] p1: поднят',
        'p1 [info] p1: раз',
        'p2 [error] p2: ошибка',
        'p2 [info] p2: два',
        'p2 [info] p2: из продолжения',
        'p2 [info] p2: из таймера',
        'p2 [info] p2: поднят',
        'p2 [warn] p2: осторожно',
      ],
    );
  } finally {
    await k.unload();
  }
});

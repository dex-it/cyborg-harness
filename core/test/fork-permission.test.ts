import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load, type JournalEntry, type Kernel } from '../src/loader.ts';
import { forkHosts, type SpawnHost } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

// TR-20 (docs/research/trust-and-isolation/06-work-plan.md, 5.3): хост плагинов - процесс Node под `--permission` с пустым env. Весь протокол ядра идёт по каналу `fork`
// (advanced-сериализация): вызов, исключение, клонирование, сторож, перезапуск. Настоящие процессы Node, без подделок канала.

const CORE_SRC = fileURLToPath(new URL('../src', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const OUTSIDE = fileURLToPath(new URL('../../package.json', import.meta.url));

const manifests = [
  {
    id: 'sandboxed',
    version: '1.0.0',
    engines: { cyborg: '^1' },
    commands: { 'sandboxed.probe': { args: ['string'] }, 'sandboxed.echo': { args: ['any'] }, 'sandboxed.bytes': { args: ['any'] }, 'sandboxed.leak': {}, 'sandboxed.hang': {}, 'sandboxed.crash': {} },
  },
];

function start(spawnHost = confined()): Promise<Kernel> {
  return load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['sandboxed'],
    manifests,
    spawnHost,
    entry: () => new URL('./fixtures/sandboxed.ts', import.meta.url).href,
    watchdog: { interval: 50, timeout: 1500, strikes: 5 },
  });
}

/** Хост как в TR-21: пустой env, чтение только каталогов ядра и плагина, без child-process, worker и аддонов. */
const confined = () => forkHosts({ silent: true, env: {}, execArgv: ['--permission', `--allow-fs-read=${CORE_SRC}`, `--allow-fs-read=${FIXTURES}`] });

interface Probe {
  pid: number;
  permission: string;
  env: string[];
  execArgv: string[];
  readOutside: string;
  spawn: string;
}
const downs = (k: Kernel) => k.journal.filter((e): e is Extract<JournalEntry, { kind: 'host-down' }> => e.kind === 'host-down').map((d) => [d.hostId, d.reason]);

test('TR-20: хост под --permission и с пустым env: запреты действуют внутри процесса плагина, env пуст', async () => {
  const k = await start();
  try {
    const probe = (await k.run('sandboxed.probe', OUTSIDE)) as Probe;
    assert.notEqual(probe.pid, process.pid);
    assert.equal(probe.permission, 'object', 'process.permission определён: запреты Node действуют');
    // macOS сама кладёт в любой процесс `__CF_USER_TEXT_ENCODING` (CoreFoundation, не от ядра); больше в пустом env ничего нет.
    assert.deepEqual(probe.env.filter((name) => name !== '__CF_USER_TEXT_ENCODING'), [], 'env хоста пуст');
    assert.ok(probe.execArgv.includes('--permission'));
    assert.equal(probe.readOutside, 'ERR_ACCESS_DENIED', 'чтение вне разрешённых каталогов');
    assert.equal(probe.spawn, 'ERR_ACCESS_DENIED', 'запуск процесса без --allow-child-process');
  } finally {
    await k.unload();
  }
});

test('TR-20: без execArgv и env хост прежний: env унаследован, запретов нет (поведение forkHosts по умолчанию не менялось)', async () => {
  const k = await start(forkHosts({ silent: true }));
  try {
    const probe = (await k.run('sandboxed.probe', OUTSIDE)) as Probe;
    assert.equal(probe.permission, 'undefined');
    assert.ok(probe.env.length > 0);
    assert.equal(probe.readOutside, 'выполнено');
    assert.equal(probe.spawn, 'выполнено');
  } finally {
    await k.unload();
  }
});

test('TR-20: структурное клонирование через канал fork под --permission: Map, Set, Date, BigInt, Uint8Array, вложенность; функция в ответе - NotCloneable', async () => {
  const k = await start();
  try {
    const value = { map: new Map([['a', { n: 1n }]]), set: new Set([1, 2]), date: new Date(0), bytes: new Uint8Array([1, 2, 3]), nested: { list: [[1], [2]] }, nan: Number.NaN };
    assert.deepEqual(await k.run('sandboxed.echo', value), value);
    assert.deepEqual(await k.run('sandboxed.bytes', new Uint8Array([4, 5, 6])), { isU8: true, length: 3, sum: 15 });
    await assert.rejects(k.run('sandboxed.leak'), { code: 'NotCloneable' });
  } finally {
    await k.unload();
  }
});

test('TR-20: сторож: пинг ядра идёт по каналу fork под --permission - зависание находится, падение и перезапуск работают', async () => {
  const k = await start();
  try {
    await assert.rejects(k.run('sandboxed.hang'), { code: 'HostGone' });
    await k.idle();
    assert.deepEqual(downs(k), [['sandboxed', 'hang']]);
    // Перезапущенный хост снова под запретами.
    assert.equal(((await k.run('sandboxed.probe', OUTSIDE)) as Probe).readOutside, 'ERR_ACCESS_DENIED');
    await assert.rejects(k.run('sandboxed.crash'), { code: 'HostGone' });
    await k.idle();
    assert.deepEqual(downs(k), [['sandboxed', 'hang'], ['sandboxed', 'crash']]);
    assert.equal(((await k.run('sandboxed.probe', OUTSIDE)) as Probe).permission, 'object');
  } finally {
    await k.unload();
  }
});

test('ST-3010/1: TR-21: канал json с кодеком типов возвращает Map, Set, Date, BigInt, байты, Error; функция в ответе - NotCloneable, как у advanced (без кодека json их терял: TR-20)', async () => {
  const k = await start(forkHosts({ silent: true, serialization: 'json', env: {}, execArgv: ['--permission', `--allow-fs-read=${CORE_SRC}`, `--allow-fs-read=${FIXTURES}`] }));
  try {
    const value = { map: new Map([['a', { n: 1n }]]), set: new Set([1, 2]), date: new Date(0), bytes: new Uint8Array([1, 2, 3]), error: new RangeError('x', { cause: 'y' }), list: [1, undefined, Number.NaN] };
    assert.deepEqual(await k.run('sandboxed.echo', value), value);
    assert.deepEqual(await k.run('sandboxed.bytes', new Uint8Array([4, 5, 6])), { isU8: true, length: 3, sum: 15 });
    await assert.rejects(k.run('sandboxed.leak'), { code: 'NotCloneable' });
  } finally {
    await k.unload();
  }
});

test('ST-3010/1: TR-21: проверенные байты под --permission: каталог плагина хосту читать нельзя, плагин грузится из набора (хуки resolve и load); адрес через ссылку приведён к настоящему пути', async () => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-verified-real-')));
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  const files = {
    'index.mjs': "import { twice } from './lib/twice.mjs'; export default { activate(ctx) { ctx.commands.register('verified.twice', (n) => twice(n)); } };\n",
    'lib/twice.mjs': 'export const twice = (n) => n * 2;\n',
  };
  fs.mkdirSync(path.join(real, 'lib'));
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(real, file), text);
  const verified = { base: pathToFileURL(`${real}${path.sep}`).href, files: Object.fromEntries(Object.entries(files).map(([f, t]) => [f, Buffer.from(t).toString('base64')])) };
  const hostAllowed = ['--permission', `--allow-fs-read=${CORE_SRC}`];
  const run = async (spawnHost: SpawnHost, withProvenance: boolean) => {
    const k = await load({
      apiVersion: PLUGIN_API_VERSION,
      enabled: ['verified'],
      manifests: [{ id: 'verified', version: '1.0.0', engines: { cyborg: '^1' }, commands: { 'verified.twice': { args: ['number'] } } }],
      spawnHost,
      // Адрес назван через ссылку: проверенный набор записан под настоящим путём.
      entry: () => pathToFileURL(path.join(link, 'index.mjs')).href,
      ...(withProvenance && { provenance: { check: () => Promise.resolve({ ok: true as const, verified }) } }),
      watchdog: { interval: 50, timeout: 1500, strikes: 5 },
    });
    await k.idle();
    return k;
  };
  const k = await run(forkHosts({ silent: true, env: {}, execArgv: hostAllowed }), true);
  try {
    assert.equal(await k.run('verified.twice', 21), 42, 'плагин с относительным импортом загружен из проверенных байтов, хотя его каталог хосту не разрешён');
    // Контроль: без проверенных байтов тот же хост плагин не прочтёт.
    fs.writeFileSync(path.join(real, 'lib', 'twice.mjs'), 'export const twice = (n) => n * 1000;\n');
    assert.equal(await k.run('verified.twice', 21), 42, 'подмена файла после проверки до исполнения не доходит');
  } finally {
    await k.unload();
  }
  const control = await run(forkHosts({ silent: true, env: {}, execArgv: hostAllowed }), false);
  try {
    assert.ok(!control.active.includes('verified'), 'без проверенных байтов хост под --permission каталог плагина не читает');
    assert.match(JSON.stringify(control.journal), /Use --allow-fs-read/);
  } finally {
    await control.unload();
    fs.rmSync(link);
    fs.rmSync(real, { recursive: true });
  }
});

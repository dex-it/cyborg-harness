import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, lstat, mkdtemp, mkdir, open, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PluginContext, PluginOs } from '@cyborg-harness/contracts';
import { SectionStore, type LayerStore } from '../src/config.ts';
import { load as loadKernel, type Kernel, type LoadOptions } from '../src/loader.ts';
import { trackKernels } from './kernels.ts';
import { parseManifest } from '../src/manifest.ts';
import { describePermissions, envNameAllowed } from '../src/permissions.ts';
import type { NoticeEvents } from '../src/notices.ts';
import { memorySecrets } from '../../testing/src/memory.ts';
import { OsGateway, type OsEnvironment } from '../src/os-gateway.ts';
import { inlineHosts } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { waitFor } from './wait-for.ts';

// Ядро выгружается после каждого теста файла, и упавшим тоже: иначе слежение и программы держат процесс файла (core/test/kernels.ts).
const track = trackKernels();
const load = async (options: LoadOptions): Promise<Kernel> => track(await loadKernel(options));

const manifest = (id: string, permissions?: unknown) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...(permissions !== undefined && { permissions }) });

async function sandbox() {
  // На macOS tmpdir - симлинк /var -> /private/var, а шлюз отдаёт пути после realpath.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-os-')));
  const dirs = { data: path.join(root, 'data'), temp: path.join(root, 'temp'), work: path.join(root, 'work'), outside: path.join(root, 'outside') };
  for (const d of [dirs.work, dirs.outside]) await mkdir(d, { recursive: true });
  return { root, ...dirs, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}

/** Плагины отдают свой ctx наружу: тест зовёт ctx.os так же, как плагин. */
async function kernel(plugins: Record<string, unknown>, env: Partial<OsEnvironment> & Pick<OsEnvironment, 'dataDir' | 'tempDir'>, config?: Record<string, unknown>) {
  const contexts = new Map<string, PluginContext>();
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async (entry) => ({ activate: (ctx: PluginContext) => void contexts.set(entry, ctx) })),
    enabled: Object.keys(plugins),
    manifests: Object.entries(plugins).map(([id, p]) => manifest(id, p)),
    os: env,
    ...(config && { config: { raw: (id: string) => (id in config ? [['user', config[id]]] : []) } as never }),
  });
  const os = (id: string): PluginOs => {
    const ctx = contexts.get(id);
    assert.ok(ctx, `${id} не активирован`);
    return ctx.os;
  };
  const denied = () => k.journal.filter((e) => e.kind === 'denied').map((e) => `${e.pluginId}:${e.method}`);
  return { k, os, ctx: (id: string) => contexts.get(id)!, denied };
}

test('без прав: свои каталоги работают, чужой путь - PermissionDenied и запись в журнале', async () => {
  await using box = await sandbox();
  const { k, os, denied } = await kernel({ plain: undefined }, { dataDir: box.data, tempDir: box.temp });
  const own = os('plain');
  assert.equal(own.paths.data, path.join(box.data, 'plain'));
  assert.equal(own.process, undefined);
  assert.equal(own.net, undefined);
  assert.equal(own.clipboard, undefined);
  const file = path.join(own.paths.data, 'a', 'note.txt');
  await own.fs.mkdir(path.dirname(file));
  await own.fs.writeText(file, 'привет');
  assert.equal(await own.fs.readText(file), 'привет');
  assert.deepEqual(await own.fs.list(path.dirname(file)), [{ name: 'note.txt', kind: 'file' }]);
  assert.equal((await own.fs.stat(file)).size, Buffer.byteLength('привет'));
  await assert.rejects(own.fs.readText(path.join(box.outside, 'x')), { code: 'PermissionDenied' });
  await assert.rejects(own.fs.readText('relative.txt'), { code: 'PermissionDenied' });
  await assert.rejects(own.fs.remove(own.paths.data), { code: 'PermissionDenied' });
  assert.deepEqual(denied(), ['plain:fs.readText', 'plain:fs.readText', 'plain:fs.remove']);
  await k.unload();
});

test('свой каталог, подменённый ссылкой наружу после первого вызова, область плагина не расширяет', async () => {
  await using box = await sandbox();
  await writeFile(path.join(box.outside, 'secret.txt'), 'нельзя');
  const { k, os } = await kernel({ plain: undefined }, { dataDir: box.data, tempDir: box.temp });
  const own = os('plain');
  await own.fs.writeText(path.join(own.paths.data, 'a.txt'), 'a');
  await rm(own.paths.data, { recursive: true });
  await symlink(box.outside, own.paths.data);
  await assert.rejects(own.fs.readText(path.join(own.paths.data, 'secret.txt')), { code: 'PermissionDenied' });
  await k.unload();
});

test('fs.read и fs.write: область по праву, симлинк наружу не пускает, .git, защищённые пути и их соседи <файл>.* закрыты', async () => {
  await using box = await sandbox();
  await writeFile(path.join(box.outside, 'secret.txt'), 'нельзя');
  await writeFile(path.join(box.work, 'readme.md'), 'можно');
  await symlink(box.outside, path.join(box.work, 'escape'));
  await mkdir(path.join(box.work, '.git'));
  const workspaceFile = path.join(box.work, 'cyborg.json');
  await writeFile(workspaceFile, '{}');
  await writeFile(`${workspaceFile}.corrupt-2026-11-07T10-00-00-000Z`, '{"secret"');
  await writeFile(path.join(box.work, 'cyborg.json5'), 'чужое имя');
  const { k, os } = await kernel(
    { reader: { 'fs.read': [box.work] }, writer: { 'fs.read': [box.work], 'fs.write': [box.work] } },
    { dataDir: box.data, tempDir: box.temp, protectedPaths: [workspaceFile] },
  );
  assert.equal(await os('reader').fs.readText(path.join(box.work, 'readme.md')), 'можно');
  await assert.rejects(os('reader').fs.readText(path.join(box.work, 'escape', 'secret.txt')), { code: 'PermissionDenied' });
  await assert.rejects(os('reader').fs.writeText(path.join(box.work, 'new.txt'), 'x'), { code: 'PermissionDenied' });
  await assert.rejects(os('reader').fs.readText(workspaceFile), { code: 'PermissionDenied' });
  await assert.rejects(os('reader').fs.readText(`${workspaceFile}.corrupt-2026-11-07T10-00-00-000Z`), { code: 'PermissionDenied' }, 'копия битого файла несёт его содержимое');
  await assert.rejects(os('writer').fs.writeText(`${workspaceFile}.4242.tmp`, 'x'), { code: 'PermissionDenied' }, 'временный файл атомарной записи');
  assert.equal(await os('reader').fs.readText(path.join(box.work, 'cyborg.json5')), 'чужое имя', 'сосед - только с точкой после имени');
  await os('writer').fs.mkdir(path.join(box.work, 'deep'));
  await os('writer').fs.writeText(path.join(box.work, 'deep', 'new.txt'), 'x');
  assert.equal(await readFile(path.join(box.work, 'deep', 'new.txt'), 'utf8'), 'x');
  await assert.rejects(os('writer').fs.writeText(path.join(box.work, '.git', 'config'), 'x'), { code: 'PermissionDenied' });
  await assert.rejects(os('writer').fs.writeText(path.join(box.work, 'escape', 'secret.txt'), 'x'), { code: 'PermissionDenied' });
  assert.equal(await readFile(path.join(box.outside, 'secret.txt'), 'utf8'), 'нельзя');
  await k.unload();
});

test('workspace: корни от приложения и от плагина с security.roots; права уходят вместе с плагином', async () => {
  await using box = await sandbox();
  await writeFile(path.join(box.outside, 'b.txt'), 'b');
  await writeFile(path.join(box.work, 'a.txt'), 'a');
  const { k, os } = await kernel(
    { projects: { 'security.roots': true }, tool: { 'fs.read': ['workspace'] } },
    { dataDir: box.data, tempDir: box.temp, roots: () => [box.work] },
  );
  assert.equal(await os('tool').fs.readText(path.join(box.work, 'a.txt')), 'a');
  await assert.rejects(os('tool').fs.readText(path.join(box.outside, 'b.txt')), { code: 'PermissionDenied' });
  await os('projects').security!.setRoots([box.outside]);
  assert.equal(await os('tool').fs.readText(path.join(box.outside, 'b.txt')), 'b');
  assert.equal(os('tool').security, undefined);
  await k.disable('projects');
  await assert.rejects(os('tool').fs.readText(path.join(box.outside, 'b.txt')), { code: 'PermissionDenied' });
  await k.unload();
});

test('process.run: программа и префикс аргументов из права, без shell', async () => {
  await using box = await sandbox();
  const { k, os, denied } = await kernel(
    { runner: { process: [{ program: process.execPath, args: ['-e'], env: ['X'] }], 'fs.read': [box.work] } },
    { dataDir: box.data, tempDir: box.temp, env: { PATH: '/usr/bin', HOME: '/h', NODE_OPTIONS: '--require /evil.js', GIT_CONFIG_COUNT: '1' } },
  );
  const proc = os('runner').process!;
  const result = await proc.run(process.execPath, ['-e', 'process.stdout.write(process.env.X + require("fs").readFileSync(0, "utf8"))'], { env: { X: 'env:' }, input: 'stdin' });
  assert.deepEqual([result.code, result.stdout], [0, 'env:stdin']);
  const env = await proc.run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.NODE_OPTIONS, process.env.GIT_CONFIG_COUNT, process.env.HOME, process.cwd()]))'], { cwd: box.work });
  assert.deepEqual(JSON.parse(env.stdout), [null, null, '/h', box.work], 'чужое окружение Cyborg дошло до программы');
  await assert.rejects(proc.run(process.execPath, ['-e', '0'], { env: { GIT_CONFIG_COUNT: '1' } }), { code: 'PermissionDenied' });
  await assert.rejects(proc.run(process.execPath, ['-e', '0'], { cwd: box.outside }), { code: 'PermissionDenied' });
  await assert.rejects(proc.run(process.execPath, ['--version']), { code: 'PermissionDenied' });
  await assert.rejects(proc.run('/bin/sh', ['-c', 'echo']), { code: 'PermissionDenied' });
  assert.deepEqual(denied(), ['runner:process.run', 'runner:process.run', 'runner:process.run', 'runner:process.run']);
  await k.unload();
});

test('process.run: вывод больше предела - truncated, программа остановлена, прочитанное до предела целое по символам; предел в байтах и по потокам', async (t) => {
  await using box = await sandbox();
  const { k, os } = await kernel({ runner: { process: [{ program: process.execPath, args: ['-e'] }] } }, { dataDir: box.data, tempDir: box.temp, limits: { processOutput: 1000, processOutputMax: 4000 } });
  // Иначе упавшая проверка оставит наблюдатель или программу живыми, и процесс файла не выйдет до срока job.
  t.after(() => k.unload());
  const run = (script: string, options?: object) => os('runner').process!.run(process.execPath, ['-e', script], options);
  const small = await run(`process.stdout.write('я'.repeat(500));process.stderr.write('e')`);
  assert.deepEqual([small.code, small.truncated, small.stdout.length], [0, false, 500], 'ровно в предел (1000 байт) - не обрезано');
  const over = await run(`process.stdout.write('я'.repeat(501))`);
  assert.equal(over.truncated, true, 'предел в байтах, а не в символах: 501 символ по 2 байта');
  assert.equal(over.stdout, 'я'.repeat(500), 'обрыв на границе символа, без U+FFFD');
  const odd = await run(`process.stdout.write('a'+'я'.repeat(600))`);
  assert.deepEqual([odd.truncated, odd.stdout], [true, 'a' + 'я'.repeat(499)], 'половина символа на границе предела отброшена');
  const err = await run(`process.stderr.write('x'.repeat(2000))`);
  assert.deepEqual([err.truncated, err.stderr.length, err.stdout], [true, 1000, '']);
  const endless = await run(`for(;;)process.stdout.write('x'.repeat(65536))`);
  assert.deepEqual([endless.truncated, endless.signal, endless.stdout.length], [true, 'SIGTERM', 1000], 'бесконечный вывод останавливает программу');
  const deaf = await run(`process.on('SIGTERM',()=>{});process.stdout.write('x'.repeat(2000));setInterval(()=>{},1000)`);
  assert.deepEqual([deaf.truncated, deaf.signal], [true, 'SIGKILL'], 'программа, глушащая SIGTERM, добита');
  const raised = await run(`process.stdout.write('x'.repeat(3000))`, { maxOutputBytes: 3000 });
  assert.deepEqual([raised.truncated, raised.stdout.length], [false, 3000], 'опция поднимает предел');
  const lowered = await run(`process.stdout.write('x'.repeat(100))`, { maxOutputBytes: 10 });
  assert.deepEqual([lowered.truncated, lowered.stdout], [true, 'x'.repeat(10)], 'опция опускает предел');
  for (const bad of [0, -1, 1.5, 4001, '10', Number.NaN]) await assert.rejects(run('0', { maxOutputBytes: bad }), { code: 'Invalid', message: /maxOutputBytes/ }, String(bad));
});

test('process.run: тайм-аут программы, глушащей SIGTERM, кончается SIGKILL, а не висит в пределе runs', async (t) => {
  await using box = await sandbox();
  const { k, os } = await kernel({ runner: { process: [{ program: process.execPath, args: ['-e'] }] } }, { dataDir: box.data, tempDir: box.temp, limits: {} });
  // Иначе упавшая проверка оставит наблюдатель или программу живыми, и процесс файла не выйдет до срока job.
  t.after(() => k.unload());
  const started = Date.now();
  // Тайм-аут с запасом на запуск node: на занятом раннере SIGTERM приходил раньше, чем программа успевала заглушить его, и она умирала по SIGTERM, а не по SIGKILL.
  const got = await os('runner').process!.run(process.execPath, ['-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`], { timeoutMs: 1500 });
  assert.deepEqual([got.signal, got.truncated], ['SIGKILL', false]);
  assert.ok(Date.now() - started < 8000, 'не ждали вечно');
});

test('process.run: SIGKILL после выхода лидера идёт только группе, а не его освободившемуся pid', { skip: process.platform === 'win32' && 'группы процессов POSIX' }, async (t) => {
  await using box = await sandbox();
  const { k, os } = await kernel({ runner: { process: [{ program: process.execPath, args: ['-e'] }] } }, { dataDir: box.data, tempDir: box.temp, limits: {} });
  t.after(() => k.unload());
  const kill = t.mock.method(process, 'kill');
  // Лидер умирает от SIGTERM, а вывод держит потомок в своей сессии: close ждёт его, и таймер SIGKILL срабатывает уже после выхода лидера.
  // Тайм-аут с запасом на запуск node на занятом раннере (лидер успевает назвать pid), а потомок живёт дольше тайм-аута и отсрочки SIGKILL (2 с) вместе.
  const daemon = `require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},4500)'],{detached:true,stdio:['ignore','inherit','inherit']}).unref();process.stderr.write(String(process.pid));setInterval(()=>{},1000)`;
  const got = await os('runner').process!.run(process.execPath, ['-e', daemon], { timeoutMs: 1500 });
  const leader = Number(got.stderr);
  assert.ok(leader > 0);
  assert.deepEqual(kill.mock.calls.map((c) => c.arguments[0]).filter((pid) => pid === leader), [], 'собранный лидер не получает сигналов по своему pid');
});

test('process.run: предел вывода по умолчанию - 16 МиБ, как и записано в SAD', async () => {
  await using box = await sandbox();
  const { k, os } = await kernel({ runner: { process: [{ program: process.execPath, args: ['-e'] }] } }, { dataDir: box.data, tempDir: box.temp });
  const script = (mib: number) => `const b=Buffer.alloc(1048576,97);for(let i=0;i<${String(mib)};i++)process.stdout.write(b)`;
  const exact = await os('runner').process!.run(process.execPath, ['-e', script(16)]);
  assert.deepEqual([exact.truncated, exact.stdout.length], [false, 16 * 1024 * 1024]);
  const over = await os('runner').process!.run(process.execPath, ['-e', script(17)]);
  assert.deepEqual([over.truncated, over.stdout.length], [true, 16 * 1024 * 1024]);
  const big = await os('runner').process!.run(process.execPath, ['-e', script(64)], { maxOutputBytes: 64 * 1024 * 1024 });
  assert.deepEqual([big.truncated, big.stdout.length], [false, 64 * 1024 * 1024], 'буфер трекеров Cyborg - 64 МиБ - укладывается в потолок');
  await k.unload();
});

test('net.fetch: хост из права или из config, переадресация не идёт сама', async () => {
  await using box = await sandbox();
  const calls: string[] = [];
  const fakeFetch = (async (url: URL, init: RequestInit) => {
    calls.push(`${url.host}:${String(init.redirect)}`);
    return new Response('ok', { status: 200, headers: { 'x-a': '1' } });
  }) as unknown as typeof fetch;
  const { k, os } = await kernel(
    { web: { net: ['api.example.com', 'config:baseUrl'] } },
    { dataDir: box.data, tempDir: box.temp, fetch: fakeFetch },
    { web: { baseUrl: 'https://jira.corp.local' } },
  );
  const net = os('web').net!;
  assert.deepEqual(await net.fetch('https://api.example.com/v1'), { status: 200, headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-a': '1' }, body: 'ok' });
  await net.fetch('https://jira.corp.local/rest');
  await assert.rejects(net.fetch('https://api.example.com:8443/'), { code: 'PermissionDenied' }, 'хост без порта пустил на любой порт');
  await assert.rejects(net.fetch('https://evil.example.com/'), { code: 'PermissionDenied' });
  await assert.rejects(net.fetch('file:///etc/passwd'), { code: 'PermissionDenied' });
  assert.deepEqual(calls, ['api.example.com:manual', 'jira.corp.local:manual']);
  await k.unload();
});

test('env, notify, clipboard: только названное в праве; нет адаптера - Unavailable', async () => {
  await using box = await sandbox();
  const shown: string[] = [];
  let clip = 'старое';
  const { k, os } = await kernel(
    { a: { env: ['HOME_X'], notify: true, clipboard: ['read'] }, b: { notify: true } },
    { dataDir: box.data, tempDir: box.temp, env: { HOME_X: '/h', SECRET: 's' }, notify: (t, b) => void shown.push(`${t}|${b ?? ''}`), clipboard: { readText: () => clip, writeText: (t) => void (clip = t) } },
  );
  assert.equal(await os('a').env!.get('HOME_X'), '/h');
  await assert.rejects(os('a').env!.get('SECRET'), { code: 'PermissionDenied' });
  await os('a').notify!.show('Готово', 'тесты');
  assert.deepEqual(shown, ['Готово|тесты']);
  assert.equal(await os('a').clipboard!.readText!(), 'старое');
  assert.equal('writeText' in os('a').clipboard!, false);
  assert.equal(os('b').clipboard, undefined);
  await k.unload();
  const bare = await kernel({ c: { notify: true } }, { dataDir: box.data, tempDir: box.temp });
  await assert.rejects(bare.os('c').notify!.show('x'), { code: 'Unavailable' });
  await bare.k.unload();
});

test('notify: клик поднимает окно, закрывает уведомление и запускает свою команду; команда и аргументы сверяются при show; close, пределы и выгрузка', async () => {
  await using box = await sandbox();
  const shown: { title: string; body: string | undefined; events: NoticeEvents; closed: boolean }[] = [];
  const ran: unknown[] = [];
  let raised = 0;
  const contexts = new Map<string, PluginContext>();
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async (entry) => ({
      activate: (ctx: PluginContext) => {
        contexts.set(entry, ctx);
        if (entry === 'bell') ctx.commands.register('bell.open', (session) => void ran.push(session));
      },
    })),
    enabled: ['bell', 'mute'],
    manifests: [
      { ...manifest('bell', { notify: true }), commands: { 'bell.open': { args: ['string'] } } },
      { ...manifest('mute', { notify: true }), commands: { 'mute.go': {} } },
    ],
    os: {
      dataDir: box.data,
      tempDir: box.temp,
      notifyLimits: { title: 20, body: 50, live: 2 },
      raiseWindow: () => {
        raised++;
      },
      notify: (title, body, events) => {
        const n = { title, body, events, closed: false };
        shown.push(n);
        return {
          close: () => {
            n.closed = true;
          },
        };
      },
    },
  });
  const bell = contexts.get('bell')!.os.notify!;
  const first = await bell.show('Сессия ждёт', 'ответа', { onClick: { command: 'bell.open', args: ['s1'] } });
  assert.equal(typeof first, 'string');
  shown[0]!.events.click();
  await waitFor('команда уведомления выполнена', () => ran.length > 0);
  assert.deepEqual(ran, ['s1']);
  assert.equal(raised, 1);
  assert.equal(shown[0]!.closed, true, 'клик закрывает уведомление');
  shown[0]!.events.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ran, ['s1'], 'второй клик по закрытому не повторяет команду');

  await assert.rejects(bell.show('x', undefined, { onClick: { command: 'bell.nope' } }), { code: 'CommandNotFound' });
  await assert.rejects(bell.show('x', undefined, { onClick: { command: 'mute.go' } }), { code: 'CommandNotFound' }, 'чужая команда');
  await assert.rejects(bell.show('x', undefined, { onClick: { command: 'bell.open', args: [42] } }), { code: 'Invalid' });
  await assert.rejects(bell.show('x'.repeat(21)), { code: 'Invalid' });
  await assert.rejects(bell.show('x', 'y'.repeat(51)), { code: 'Invalid' });
  assert.equal(shown.length, 1, 'отказ не доходит до среды');

  const a = await bell.show('a');
  const b = await bell.show('b');
  await bell.close(a);
  await bell.close(a);
  assert.equal(shown[1]!.closed, true);
  await contexts.get('mute')!.os.notify!.close(b);
  assert.equal(shown[2]!.closed, false, 'чужой id ничего не закрывает');
  await bell.show('c');
  await bell.show('d');
  assert.deepEqual(shown.slice(2).map((n) => n.closed), [true, false, false], 'на пределе закрывается старейшее, а новое показывается');
  shown[3]!.events.closed();
  await bell.show('e');
  assert.deepEqual(shown.slice(4).map((n) => n.closed), [false, false], 'закрытое ОС уведомление место освобождает');
  shown[2]!.events.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ran, ['s1'], 'клик по вытесненному не запускает команду');
  await Promise.all([bell.show('f'), bell.show('g')]);
  assert.deepEqual(shown.slice(4).map((n) => n.closed), [true, true, false, false], 'параллельные вызовы предел не обходят');

  await k.disable('bell');
  assert.deepEqual(shown.slice(6).map((n) => n.closed), [true, true], 'выгрузка закрывает живые уведомления');
  await k.unload();
});

test('секреты: ключи своего плагина, $secret, без шифрования ОС - Unavailable, внешний источник по маске', async () => {
  await using box = await sandbox();
  const store = memorySecrets();
  const { k, os, ctx } = await kernel({ jira: { 'secrets.ref': ['vault://kv/jira*'] }, other: undefined }, { dataDir: box.data, tempDir: box.temp, secrets: store });
  await os('jira').secrets.set('token', 't-1');
  assert.deepEqual([...store.map.keys()], ['jira/token']);
  assert.equal(await os('other').secrets.get('token'), undefined);
  assert.deepEqual(await ctx('jira').secrets.resolve({ $secret: 'token' }), { value: 't-1' });
  await assert.rejects(ctx('jira').secrets.resolve('vault://kv/jira/token'), { code: 'Unavailable' });
  await assert.rejects(ctx('jira').secrets.resolve('vault://kv/gitlab'), { code: 'PermissionDenied' });
  await assert.rejects(ctx('other').secrets.resolve('missing'), { code: 'Unavailable' });
  await os('jira').secrets.delete('token');
  assert.equal(store.map.size, 0);
  await k.unload();
  const locked = await kernel({ x: undefined }, { dataDir: box.data, tempDir: box.temp, secrets: memorySecrets(false) });
  await assert.rejects(locked.os('x').secrets.set('k', 'v'), { code: 'Unavailable' });
  await locked.k.unload();
});

test('NotFound: нет файла, каталога или программы - NotFound, а не безымянный Remote; чужой путь по-прежнему PermissionDenied', async () => {
  await using box = await sandbox();
  await writeFile(path.join(box.work, 'file.txt'), 'x');
  const { k, os, denied } = await kernel({ reader: { 'fs.read': [box.work], 'fs.write': [box.work], process: [{ program: process.execPath, args: ['-e'] }, 'cyborg-no-such-program'] } }, { dataDir: box.data, tempDir: box.temp });
  const fs = os('reader').fs;
  const gone = path.join(box.work, 'gone');
  for (const [name, call] of Object.entries({
    readText: () => fs.readText(gone),
    readSlice: () => fs.readSlice(gone, 0, 16),
    stat: () => fs.stat(gone),
    list: () => fs.list(gone),
    'stat под файлом': () => fs.stat(path.join(box.work, 'file.txt', 'child')),
    watch: () => fs.watch(gone, () => undefined),
  })) await assert.rejects(call(), { code: 'NotFound', message: /ENOENT|ENOTDIR/ }, name);
  await assert.rejects(fs.stat(path.join(box.outside, 'gone')), { code: 'PermissionDenied' }, 'вне области существования файла не выдаём');
  await assert.rejects(os('reader').process!.run('cyborg-no-such-program', []), { code: 'NotFound', message: /cyborg-no-such-program/ });
  await assert.rejects(os('reader').process!.run(process.execPath, ['-e', '0'], { cwd: gone }), { code: 'NotFound' }, 'каталога запуска нет - тоже ENOENT от spawn');
  assert.deepEqual(denied(), ['reader:fs.stat'], 'NotFound в журнал отказов не идёт');
  await k.unload();
});

test('вне области любая ошибка ОС при раскрытии пути (ENOTDIR, ELOOP, EACCES) - PermissionDenied: файл вне области не выдаёт себя ни кодом, ни текстом', async () => {
  await using box = await sandbox();
  const secret = path.join(box.outside, 'secret');
  await writeFile(secret, 'x');
  await symlink(path.join(box.outside, 'loop'), path.join(box.outside, 'loop'));
  const locked = path.join(box.outside, 'locked');
  await mkdir(path.join(locked, 'dir'), { recursive: true });
  const { k, os, denied } = await kernel({ reader: { 'fs.read': [box.work] } }, { dataDir: box.data, tempDir: box.temp });
  const fs = os('reader').fs;
  const paths = { 'под файлом (ENOTDIR)': path.join(secret, 'child'), 'под файлом глубже': path.join(secret, 'a', 'b'), 'петля ссылок (ELOOP)': path.join(box.outside, 'loop'), 'под петлёй': path.join(box.outside, 'loop', 'x') };
  const calls = (p: string) => ({ stat: () => fs.stat(p), readText: () => fs.readText(p), readSlice: () => fs.readSlice(p, 0, 16), list: () => fs.list(p), realpath: () => fs.realpath(p), watch: () => fs.watch(p, () => undefined) });
  let count = 0;
  for (const [name, p] of Object.entries(paths)) for (const [method, call] of Object.entries(calls(p))) {
    await assert.rejects(call(), { code: 'PermissionDenied' }, `${method} ${name}`);
    count++;
  }
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await chmod(locked, 0);
    try {
      for (const [method, call] of Object.entries(calls(path.join(locked, 'dir', 'x')))) {
        await assert.rejects(call(), { code: 'PermissionDenied' }, `${method} под каталогом без доступа (EACCES)`);
        count++;
      }
    } finally {
      await chmod(locked, 0o700);
    }
  }
  assert.equal(denied().length, count, 'каждый отказ - запись в журнале');
  assert.deepEqual(new Set(denied()), new Set(['reader:fs.stat', 'reader:fs.readText', 'reader:fs.readSlice', 'reader:fs.list', 'reader:fs.realpath', 'reader:fs.watch']));
  await k.unload();
});

test('fs.list на существующем файле - Invalid «не каталог», а не NotFound; нет пути под файлом - по-прежнему NotFound', async () => {
  await using box = await sandbox();
  await writeFile(path.join(box.work, 'file.txt'), 'x');
  const { k, os } = await kernel({ reader: { 'fs.read': [box.work] } }, { dataDir: box.data, tempDir: box.temp });
  const fs = os('reader').fs;
  await assert.rejects(fs.list(path.join(box.work, 'file.txt')), { code: 'Invalid', message: /не каталог/ });
  await assert.rejects(fs.list(path.join(box.work, 'file.txt', 'child')), { code: 'NotFound' });
  await assert.rejects(fs.list(path.join(box.work, 'gone')), { code: 'NotFound' });
  await k.unload();
});

test('fs.realpath: настоящий путь внутри области - ссылки раскрыты; нет пути - NotFound; ссылка наружу и чужой путь - PermissionDenied с записью в журнале', async () => {
  await using box = await sandbox();
  await mkdir(path.join(box.work, 'real'));
  await writeFile(path.join(box.work, 'real', 'a.txt'), 'x');
  await symlink(path.join(box.work, 'real'), path.join(box.work, 'alias'));
  await symlink(box.outside, path.join(box.work, 'escape'));
  const { k, os, denied } = await kernel({ reader: { 'fs.read': [box.work] }, plain: undefined }, { dataDir: box.data, tempDir: box.temp });
  const fs = os('reader').fs;
  assert.equal(await fs.realpath(path.join(box.work, 'alias', 'a.txt')), path.join(box.work, 'real', 'a.txt'), 'ссылка раскрыта: так ключ ~/.claude.json совпадает с каталогом проекта');
  assert.equal(await fs.realpath(path.join(box.work, 'real', '..', 'real')), path.join(box.work, 'real'));
  assert.equal(await fs.realpath(box.work), box.work);
  await assert.rejects(fs.realpath(path.join(box.work, 'gone')), { code: 'NotFound' });
  await symlink(path.join(box.work, 'gone'), path.join(box.work, 'dangling'));
  await assert.rejects(fs.realpath(path.join(box.work, 'dangling')), { code: 'NotFound' }, 'висячая ссылка не отдаётся как настоящий путь');
  await assert.rejects(fs.realpath(path.join(box.work, 'escape')), { code: 'PermissionDenied' }, 'ссылка наружу области');
  await assert.rejects(fs.realpath(box.outside), { code: 'PermissionDenied' });
  await assert.rejects(fs.realpath('relative'), { code: 'PermissionDenied' });
  await assert.rejects(os('plain').fs.realpath(path.join(box.work, 'real')), { code: 'PermissionDenied' }, 'без fs.read - только свои каталоги');
  const own = os('plain').paths.data;
  await os('plain').fs.mkdir(path.join(own, 'd'));
  assert.equal(await os('plain').fs.realpath(path.join(own, 'd')), path.join(own, 'd'), 'свой каталог доступен без права');
  assert.deepEqual(denied(), ['reader:fs.realpath', 'reader:fs.realpath', 'reader:fs.realpath', 'plain:fs.realpath']);
  await k.unload();
});

test('fs.writeText атомарна: читатель видит прежний или новый файл целиком, режим сохраняется, временных файлов не остаётся, не обычный файл - Invalid', { skip: process.platform === 'win32' && 'режимы POSIX' }, async () => {
  await using box = await sandbox();
  const { k, os } = await kernel({ writer: { 'fs.read': [box.work], 'fs.write': [box.work] } }, { dataDir: box.data, tempDir: box.temp });
  const fs = os('writer').fs;
  const file = path.join(box.work, 'state.json');
  const a = 'a'.repeat(3 * 1024 * 1024);
  const b = 'я'.repeat(1024 * 1024);
  await fs.writeText(file, a);
  await chmod(file, 0o600);
  const run = { writing: true };
  const seen = new Set<string>();
  const reader = (async () => {
    while (run.writing) {
      const text = await fs.readText(file);
      seen.add(text === a ? 'a' : text === b ? 'b' : `порча:${String(text.length)}`);
    }
  })();
  for (let i = 0; i < 30; i++) await fs.writeText(file, i % 2 === 0 ? b : a);
  run.writing = false;
  await reader;
  assert.deepEqual([...seen].filter((v) => v.startsWith('порча')), [], 'читатель не видит пустой или недописанный файл');
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'режим существующего файла сохранён');
  assert.deepEqual((await fs.list(box.work)).map((e) => e.name), ['state.json'], 'временный файл убран');
  await fs.writeText(path.join(box.work, 'new.txt'), 'новый');
  assert.equal(await readFile(path.join(box.work, 'new.txt'), 'utf8'), 'новый');
  await mkdir(path.join(box.work, 'dir'));
  await assert.rejects(fs.writeText(path.join(box.work, 'dir'), 'x'), { code: 'Invalid', message: /не обычный файл/ });
  await symlink(path.join(box.work, 'gone'), path.join(box.work, 'dangling'));
  await assert.rejects(fs.writeText(path.join(box.work, 'dangling'), 'x'), { code: 'Invalid', message: /не обычный файл/ }, 'висячая ссылка не заменяется файлом');
  assert.deepEqual((await fs.list(box.work)).map((e) => e.name).sort(), ['dangling', 'dir', 'new.txt', 'state.json']);
  await k.unload();
});

test('fs.writeText: временный файл не ложится вне fs.write - область-файл и маска пишутся на месте, режим каталога без записи не ломает запись', { skip: process.platform === 'win32' && 'режимы POSIX' }, async () => {
  await using box = await sandbox();
  const one = path.join(box.outside, 'one.json');
  const masked = path.join(box.outside, 'masked.json');
  const free = path.join(box.work, 'free.json');
  const ro = path.join(box.work, 'ro');
  await mkdir(ro);
  for (const f of [one, masked, free, path.join(ro, 'kept.json')]) await writeFile(f, 'old');
  const { k, os, denied } = await kernel({ w: { 'fs.read': [box.outside, box.work], 'fs.write': [one, path.join(box.outside, '*.json'), box.work] } }, { dataDir: box.data, tempDir: box.temp });
  // Область «только один файл»: временный файл рядом был бы вне права, поэтому запись на месте (inode тот же).
  const fs = os('w').fs;
  const ino = async (f: string) => (await stat(f)).ino;
  const before = [await ino(one), await ino(masked), await ino(free)];
  const seen: string[] = [];
  const watcher = (await import('node:fs')).watch(box.outside, (_e, name) => {
    if (name) seen.push(name);
  });
  await fs.writeText(one, 'new-one');
  await fs.writeText(masked, 'new-masked');
  await fs.writeText(free, 'new-free');
  await new Promise((r) => setTimeout(r, 100));
  watcher.close();
  assert.deepEqual([await readFile(one, 'utf8'), await readFile(masked, 'utf8'), await readFile(free, 'utf8')], ['new-one', 'new-masked', 'new-free']);
  assert.equal(await ino(one), before[0], 'one.json записан на месте: временный файл вне права не создавался');
  assert.equal(await ino(masked), before[1], 'masked.json под маску *.json - сосед masked.json.<hex>.tmp под маску не подходит');
  assert.notEqual(await ino(free), before[2], 'где временный файл разрешён, запись по-прежнему атомарна');
  assert.deepEqual(seen.filter((n) => n.endsWith('.tmp')), [], 'во внешнем каталоге временных файлов не было');
  if (process.getuid?.() !== 0) {
    await chmod(ro, 0o555);
    try {
      await fs.writeText(path.join(ro, 'kept.json'), 'rw-file-in-ro-dir');
      assert.equal(await readFile(path.join(ro, 'kept.json'), 'utf8'), 'rw-file-in-ro-dir', 'файл в каталоге без записи записывался и раньше');
    } finally {
      await chmod(ro, 0o755);
    }
  }
  assert.deepEqual(denied(), []);
  await k.unload();
});

test('fs.writeText: файл только для чтения (0444) в каталоге с записью не заменяется - EACCES, как на O_TRUNC; хоть область каталог, хоть сам файл', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'режимы POSIX, не root' }, async () => {
  await using box = await sandbox();
  const ro = path.join(box.work, 'ro.json');
  await writeFile(ro, 'old');
  await chmod(ro, 0o444);
  const { k, os } = await kernel({ dir: { 'fs.read': [box.work], 'fs.write': [box.work] }, one: { 'fs.read': [box.work], 'fs.write': [ro] } }, { dataDir: box.data, tempDir: box.temp });
  const before = await stat(ro);
  for (const id of ['dir', 'one']) {
    await assert.rejects(os(id).fs.writeText(ro, 'new'), /EACCES/, id);
    assert.equal(await readFile(ro, 'utf8'), 'old', `${id}: содержимое цело`);
    const after = await stat(ro);
    assert.equal(after.mode & 0o777, 0o444, `${id}: режим прежний`);
    assert.equal(after.ino, before.ino, `${id}: inode прежний`);
  }
  assert.deepEqual((await readdir(box.work)).filter((n) => n.endsWith('.tmp')), [], 'временных файлов не осталось');
  await chmod(ro, 0o644);
  await os('dir').fs.writeText(ro, 'new');
  assert.equal(await readFile(ro, 'utf8'), 'new', 'разрешённый chmod снова открывает запись');
  await k.unload();
});

test('fs: ссылка внутри области - ответ зависит от цели (вне существует - PermissionDenied, висячая - NotFound или ошибка операции, под закрытым каталогом снаружи - EACCES операции); обещание контракта только про путь, названный плагином', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'ссылки и режимы POSIX, не root' }, async () => {
  await using box = await sandbox();
  const closed = path.join(box.outside, 'closed');
  await mkdir(closed);
  await writeFile(path.join(closed, 'x'), 'секрет');
  await writeFile(path.join(box.outside, 'there'), 'секрет');
  await chmod(closed, 0o000);
  try {
    await symlink(path.join(box.outside, 'there'), path.join(box.work, 'to-existing'));
    await symlink(path.join(box.outside, 'нет'), path.join(box.work, 'to-missing'));
    await symlink(path.join(closed, 'x'), path.join(box.work, 'to-closed'));
    const { k, os } = await kernel({ app: { 'fs.read': [box.work] } }, { dataDir: box.data, tempDir: box.temp });
    const fs = os('app').fs;
    await assert.rejects(fs.readText(path.join(box.work, 'to-existing')), { code: 'PermissionDenied' });
    await assert.rejects(fs.stat(path.join(box.work, 'to-missing')), { code: 'NotFound' });
    await assert.rejects(fs.readText(path.join(box.work, 'to-missing')), (error: Error & { code?: string }) => error.code !== 'PermissionDenied', 'чтение висячей ссылки: ошибка самой операции, не отказ области');
    await assert.rejects(fs.stat(path.join(box.work, 'to-closed')), (error: Error & { code?: string }) => error.code === 'Remote' && error.message.includes('EACCES'));
    // Названный плагином путь вне области остаётся PermissionDenied при любом состоянии цели.
    for (const named of [path.join(box.outside, 'there'), path.join(box.outside, 'нет'), path.join(closed, 'x')]) await assert.rejects(fs.readText(named), { code: 'PermissionDenied' }, named);
    await k.unload();
  } finally {
    await chmod(closed, 0o755);
  }
});

test('fs.readSlice: кусок по байтам, символ UTF-8 не рвётся, пределы и права', async () => {
  await using box = await sandbox();
  const file = path.join(box.work, 'log.jsonl');
  await writeFile(file, 'ab' + 'я'.repeat(3) + 'z');
  const { k, os } = await kernel({ reader: { 'fs.read': [box.work] } }, { dataDir: box.data, tempDir: box.temp });
  const fs = os('reader').fs;
  const size = Buffer.byteLength('ab' + 'я'.repeat(3) + 'z');
  assert.deepEqual(await fs.readSlice(file, 0, 5), { text: 'abя', bytes: 4, size }, 'полсимвола на конце не входит');
  let text = '';
  for (let offset = 0; offset < size; ) {
    const slice = await fs.readSlice(file, offset, 5);
    text += slice.text;
    offset += slice.bytes;
  }
  assert.equal(text, 'ab' + 'я'.repeat(3) + 'z');
  assert.deepEqual(await fs.readSlice(file, size + 10, 64), { text: '', bytes: 0, size });
  await assert.rejects(fs.readSlice(file, -1, 64), { code: 'Invalid' });
  await assert.rejects(fs.readSlice(file, 0, 3), { code: 'Invalid' });
  await assert.rejects(fs.readSlice(file, 0, 2 * 1024 * 1024), { code: 'Invalid' });
  await writeFile(path.join(box.outside, 'secret'), 'x');
  await assert.rejects(fs.readSlice(path.join(box.outside, 'secret'), 0, 64), { code: 'PermissionDenied' });
  await k.unload();
});

/**
 * macOS (FSEvents) начинает доставку не в тот миг, когда fs.watch вернулся: запись сразу после него пропадает, и ждать её событие можно сколько угодно.
 * До проверки поведения пишем в наблюдаемое место, пока слежение не отзовётся; потом тест идёт как обычно. Перед проверкой событий `heard` стирают служебные.
 */
async function armed(touch: (n: number) => Promise<unknown>, heard: () => boolean): Promise<void> {
  let n = 0;
  await waitFor('слежение отозвалось на пробную запись', async () => {
    if (heard()) return true;
    await touch(n++);
    return undefined;
  });
}

const ARMED = '.armed';

test('fs.watch: имена изменённых в каталоге склеены, снятие и выгрузка закрывают наблюдение, вне области - отказ', async () => {
  await using box = await sandbox();
  const { k, os } = await kernel({ reader: { 'fs.read': [box.work] } }, { dataDir: box.data, tempDir: box.temp });
  const fs = os('reader').fs;
  const batches: (readonly string[])[] = [];
  const sub = await fs.watch(box.work, (names) => batches.push(names));
  await armed((n) => writeFile(path.join(box.work, ARMED), String(n)), () => batches.length > 0);
  await writeFile(path.join(box.work, 'a.jsonl'), '1\n');
  await appendFile(path.join(box.work, 'a.jsonl'), '2\n');
  await writeFile(path.join(box.work, 'b.jsonl'), '1\n');
  // macOS (FSEvents) в только что созданном каталоге присылает ещё и событие о самом каталоге (его имя - `work`), если создан он за миг до слежения: плагину оно не принадлежит.
  const own = path.basename(box.work);
  const written = () => batches.flat().filter((name) => name !== own && name !== ARMED);
  await waitFor('событие о b.jsonl', () => written().includes('b.jsonl'));
  assert.deepEqual([...new Set(written())].toSorted(), ['a.jsonl', 'b.jsonl']);
  assert.ok(batches.filter((names) => names.some((name) => name !== own && name !== ARMED)).length < 4, `события не склеены: ${JSON.stringify(batches)}`);
  sub.dispose();
  await new Promise((r) => setTimeout(r, 100));
  const seen = batches.length;
  await writeFile(path.join(box.work, 'c.jsonl'), '1\n');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(batches.length, seen, 'после dispose событий нет');

  const fileEvents: (readonly string[])[] = [];
  await fs.watch(path.join(box.work, 'a.jsonl'), (names) => fileEvents.push(names));
  // Дописанный файл замечен: дописываем, пока слежение не отзовётся.
  await armed((n) => appendFile(path.join(box.work, 'a.jsonl'), `3.${String(n)}\n`), () => fileEvents.length > 0);

  await assert.rejects(fs.watch(box.outside, () => undefined), { code: 'PermissionDenied' });
  await assert.rejects(fs.watch(path.join(box.work, 'нет'), () => undefined));
  await k.unload();
  await appendFile(path.join(box.work, 'a.jsonl'), '4\n');
  await new Promise((r) => setTimeout(r, 100));
});

test('fs.watch файла: каждая из записей writeText (подмена inode через rename) и запись на месте дают событие; наблюдение не молчит и onClose не зовётся', { skip: process.platform === 'win32' && 'rename поверх открытого' }, async (t) => {
  await using box = await sandbox();
  const { k, os } = await kernel({ app: { 'fs.read': [box.work], 'fs.write': [box.work] } }, { dataDir: box.data, tempDir: box.temp });
  // Иначе упавшая проверка оставит наблюдатель или программу живыми, и процесс файла не выйдет до срока job.
  t.after(() => k.unload());
  const fs = os('app').fs;
  const file = path.join(box.work, 'state.json');
  await fs.writeText(file, '0');
  const events: (readonly string[])[] = [];
  const closed: string[] = [];
  const sub = await fs.watch(file, (names) => events.push(names), (reason) => closed.push(reason));
  // Пробные записи в тот же inode, пока слежение не отзовётся; их запоздалые события стираются, чтобы не засчитаться за события проверяемых записей.
  await armed((n) => writeFile(file, `пробная ${String(n)}`), () => events.length > 0);
  await sleep(200);
  events.length = 0;
  const next = async (n: number) => {
    await waitFor(`событий ${String(n)}; onClose: ${closed.join()}`, () => events.length >= n);
  };
  for (let i = 1; i <= 4; i++) {
    await fs.writeText(file, String(i));
    await next(i);
    await new Promise((r) => setTimeout(r, 100));
  }
  await writeFile(file, 'прямая запись');
  await next(5);
  assert.deepEqual(closed, []);
  sub.dispose();
});

test('fs.watch файла: старый inode держит открытым другой процесс (tail -f) - каждая из записей writeText всё равно даёт событие', { skip: process.platform !== 'linux' && 'rename-события без IN_DELETE_SELF - особенность inotify' }, async (t) => {
  await using box = await sandbox();
  const { k, os } = await kernel({ app: { 'fs.read': [box.work], 'fs.write': [box.work] } }, { dataDir: box.data, tempDir: box.temp });
  t.after(() => k.unload());
  const fs = os('app').fs;
  const file = path.join(box.work, 'state.json');
  await fs.writeText(file, '0');
  const events: (readonly string[])[] = [];
  const closed: string[] = [];
  const sub = await fs.watch(file, (names) => events.push(names), (reason) => closed.push(reason));
  const holder = await open(file, 'r');
  try {
    for (let i = 1; i <= 3; i++) {
      await fs.writeText(file, String(i));
      await waitFor(`событий ${String(i)}; onClose: ${closed.join()}`, () => events.length >= i);
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    await holder.close();
  }
  assert.deepEqual(closed, []);
  sub.dispose();
});

test('fs.watch файла: файл удалён - onClose с причиной, а не тишина', async (t) => {
  await using box = await sandbox();
  const { k, os } = await kernel({ app: { 'fs.read': [box.work] } }, { dataDir: box.data, tempDir: box.temp });
  // Иначе упавшая проверка оставит наблюдатель или программу живыми, и процесс файла не выйдет до срока job.
  t.after(() => k.unload());
  const file = path.join(box.work, 'gone.json');
  await writeFile(file, '0');
  const closed: string[] = [];
  const touched: (readonly string[])[] = [];
  await os('app').fs.watch(file, (names) => touched.push(names), (reason) => closed.push(reason));
  await armed((n) => writeFile(file, `пробная ${String(n)}`), () => touched.length > 0);
  await rm(file);
  await waitFor('onClose после удаления файла', () => closed.length > 0);
  assert.equal(closed.length, 1, 'удаление файла закрывает наблюдение с причиной');
});

/** Наблюдатели, подставленные шлюзу: Linux не присылает `rename`, пока старый inode держит открытым другой процесс (`tail -f`) - приходит только `change`. */
function fakeWatchers() {
  const list: { w: FSWatcher; closed: boolean; fire: (event: string, name?: string) => void }[] = [];
  const watch = ((_path: string, listener: (event: string, name: string) => void) => {
    const w = Object.assign(new EventEmitter(), {
      close: () => {
        item.closed = true;
      },
    });
    const item = { w: w as unknown as FSWatcher, closed: false, fire: (event: string, name = 'state.json') => listener(event, name) };
    list.push(item);
    return w as unknown as FSWatcher;
  }) as unknown as NonNullable<OsEnvironment['watch']>;
  return { list, watch };
}

test('fs.watch файла: на change inode пути сверяется со старым - подмена без rename (старый inode держит другой процесс) переоткрывает наблюдение', async (t) => {
  await using box = await sandbox();
  const { list, watch } = fakeWatchers();
  const { k, os } = await kernel({ app: { 'fs.read': [box.work], 'fs.write': [box.work] } }, { dataDir: box.data, tempDir: box.temp, watch });
  t.after(() => k.unload());
  const fs = os('app').fs;
  const file = path.join(box.work, 'state.json');
  await fs.writeText(file, '0');
  const events: (readonly string[])[] = [];
  const closed: string[] = [];
  const sub = await fs.watch(file, (names) => events.push(names), (reason) => closed.push(reason));
  assert.equal(list.length, 1);
  // Тот же inode (дописали на месте): change не переоткрывает.
  await writeFile(file, 'на месте');
  list[0]!.fire('change');
  await waitFor('событие дописанного файла', () => events.length === 1);
  assert.equal(list.length, 1, 'inode тот же - наблюдатель прежний');
  // Файл подменён через rename, а rename-события нет: пришёл только change.
  for (let i = 1; i <= 3; i++) {
    await fs.writeText(file, String(i));
    list[i - 1]!.fire('change');
    await waitFor(`переоткрытие после подмены ${String(i)}`, () => list.length === i + 1);
    assert.equal(list[i - 1]!.closed, true, 'прежний наблюдатель закрыт');
    await waitFor(`событие подмены ${String(i)}`, () => events.length === i + 1);
  }
  list[0]!.fire('change');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(events.length, 4, 'поздние события закрытого наблюдателя отброшены');
  assert.deepEqual(closed, []);
  sub.dispose();
});

test('fs.watch файла: заменён каталогом с тем же именем - наблюдение закрыто с причиной, а не переходит на детей каталога; ссылка вместо файла - так же', async (t) => {
  await using box = await sandbox();
  const { list, watch } = fakeWatchers();
  const { k, os } = await kernel({ app: { 'fs.read': [box.work] } }, { dataDir: box.data, tempDir: box.temp, watch });
  t.after(() => k.unload());
  const fs = os('app').fs;
  for (const [name, replace] of [
    ['dir.json', async (f: string) => mkdir(f)],
    ['link.json', async (f: string) => symlink(path.join(box.work, 'other'), f)],
  ] as const) {
    const file = path.join(box.work, name);
    await writeFile(file, '0');
    await writeFile(path.join(box.work, 'other'), 'x');
    const events: (readonly string[])[] = [];
    const closed: string[] = [];
    const before = list.length;
    await fs.watch(file, (names) => events.push(names), (reason) => closed.push(reason));
    await rm(file);
    await replace(file);
    list[before]!.fire('rename', name);
    await waitFor(`${name}: onClose`, () => closed.length === 1);
    assert.match(closed[0]!, /не обычный файл/);
    assert.equal(list.length, before + 1, `${name}: новый наблюдатель на подмену не ставился`);
    assert.equal(list[before]!.closed, true);
    assert.deepEqual(events.flat().filter((n) => n !== name), [], `${name}: имена детей плагину не уходят`);
  }
});

test('fs.watch: лимит не обходится параллельными вызовами; сузились корни - наблюдение закрыто', async () => {
  await using box = await sandbox();
  const { k, os } = await kernel(
    { projects: { 'security.roots': true }, tool: { 'fs.read': ['workspace'] } },
    { dataDir: box.data, tempDir: box.temp },
  );
  const fs = os('tool').fs;
  const results = await Promise.allSettled(Array.from({ length: 70 }, () => fs.watch(os('tool').paths.data, () => undefined)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 64);
  for (const r of results) if (r.status === 'fulfilled') r.value.dispose();
  await new Promise((r) => setTimeout(r, 50));

  await os('projects').security!.setRoots([box.outside]);
  const seen: (readonly string[])[] = [];
  await fs.watch(box.outside, (names) => seen.push(names));
  await armed((n) => writeFile(path.join(box.outside, ARMED), String(n)), () => seen.length > 0);
  await writeFile(path.join(box.outside, 'a'), '1');
  const heardNames = () => seen.flat().filter((name) => name !== ARMED);
  await waitFor('событие о файле a', () => heardNames().includes('a'));
  assert.deepEqual([...new Set(heardNames())], ['a']);
  await os('projects').security!.setRoots([]);
  await writeFile(path.join(box.outside, 'b'), '1');
  await new Promise((r) => setTimeout(r, 200));
  await writeFile(path.join(box.outside, 'c'), '1');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual([...new Set(heardNames())], ['a'], 'после сужения корней событий нет');
  await k.unload();
});

test('$SHELL: оболочка входа из окружения приложения, только с закреплённым скриптом', async () => {
  assert.equal(parseManifest(manifest('p', { process: ['$SHELL'] })).ok, false, 'голая оболочка запустила бы что угодно');
  assert.equal(parseManifest(manifest('p', { process: [{ program: '$SHELL', args: ['-lc'] }] })).ok, false);
  await using box = await sandbox();
  const script = 'printf "%s|%s" "$0" "$1"';
  const rule = { program: '$SHELL', args: ['-c', script] };
  const { k, os } = await kernel({ runner: { process: [rule] } }, { dataDir: box.data, tempDir: box.temp, env: { PATH: process.env.PATH, HOME: '/h', SHELL: '/bin/sh' } });
  const r = await os('runner').process!.run('$SHELL', ['-c', script, 'arg0', 'arg1']);
  assert.deepEqual([r.code, r.stdout], [0, 'arg0|arg1']);
  await assert.rejects(os('runner').process!.run('$SHELL', ['-c', 'id']), { code: 'PermissionDenied' });
  await assert.rejects(os('runner').process!.run('/bin/sh', ['-c', script]), { code: 'PermissionDenied' }, 'путь оболочки не равен праву на $SHELL');
  const p = parseManifest(manifest('p', { pty: [{ program: '$SHELL', args: ['-lc', 'exec claude'] }] }));
  assert.ok(p.ok);
  assert.deepEqual(describePermissions(p.manifest.permissions), ['запускает в терминале: оболочка входа -lc exec claude - полный доступ через программу']);
  await k.unload();
});

test('права в манифесте: неизвестное право и неверная форма - ошибки манифеста; права словами', () => {
  const bad = parseManifest(manifest('p', { 'fs.raed': ['workspace'], net: ['https://x'], process: [{ program: 'git' }], notify: 'yes' }));
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok);
  assert.deepEqual(
    bad.errors.filter((e) => e.startsWith('permissions')).map((e) => e.split(':')[0]),
    ['permissions.fs.raed', 'permissions.net', 'permissions.notify', 'permissions.process'],
  );
  const good = parseManifest(manifest('p', { 'fs.read': ['workspace'], process: ['git', { program: 'npm', args: ['test'] }], net: ['config:url'], clipboard: ['write'] }));
  assert.ok(good.ok);
  assert.deepEqual(describePermissions(good.manifest.permissions), [
    'читает файлы: проекты воркспейса',
    'запускает программы: git, npm test - полный доступ через программу',
    'ходит в сеть: хост из настройки url',
    'буфер обмена: запись',
  ]);
});

test('net config:<поле>: хост берётся из принятого config, а не из того, что плагин записал себе сам', async () => {
  await using box = await sandbox();
  const calls: string[] = [];
  const fakeFetch = (async (url: URL) => {
    calls.push(url.host);
    return new Response('ok');
  }) as unknown as typeof fetch;
  const user: Record<string, unknown> = { baseUrl: 'https://jira.corp.local' };
  const { k, os } = await kernel({ web: { net: ['config:baseUrl'] } }, { dataDir: box.data, tempDir: box.temp, fetch: fakeFetch }, { web: user });
  user.baseUrl = 'https://attacker.example';
  await assert.rejects(os('web').net!.fetch('https://attacker.example/'), { code: 'PermissionDenied' });
  await os('web').net!.fetch('https://jira.corp.local/');
  await k.reloadSections('config', ['web']);
  await os('web').net!.fetch('https://attacker.example/');
  assert.deepEqual(calls, ['jira.corp.local', 'attacker.example']);
  await k.unload();
});

test('net config:<поле>: плагин не пишет в поле хоста значение, которого не задал человек', async () => {
  await using box = await sandbox();
  const docs = new Map<string, Record<string, unknown>>([['user', { web: { $version: 1, baseUrl: 'https://jira.corp.local' } }], ['workspace', { web: { $version: 1, baseUrl: 'https://jira2.corp.local' } }]]);
  const store = await SectionStore.open({ load: async (l) => structuredClone(docs.get(l)), save: async (l, d) => void docs.set(l, structuredClone(d)) }, ['user', 'workspace']);
  const contexts = new Map<string, PluginContext>();
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async (entry) => ({ activate: (ctx: PluginContext) => void contexts.set(entry, ctx) })),
    enabled: ['web'],
    manifests: [{ ...manifest('web', { net: ['config:baseUrl'] }), config: { version: 1 } }],
    os: { dataDir: box.data, tempDir: box.temp },
    config: store,
  });
  const config = contexts.get('web')!.config!;
  await assert.rejects(config.set('user', { baseUrl: 'https://attacker.example', theme: 'dark' }), { code: 'PermissionDenied' });
  assert.ok(k.journal.some((e) => e.kind === 'denied' && e.method === 'config.set'));
  // get() несёт baseUrl воркспейса: в слой пользователя он не переносится (ADR-CH-0015); значение самого пользователя повторить можно.
  await assert.rejects(config.set('user', { ...config.get(), theme: 'dark' }), { code: 'PermissionDenied' });
  await config.set('user', { baseUrl: 'https://jira.corp.local', theme: 'dark' });
  await config.set('workspace', { theme: 'light' });
  assert.deepEqual(store.raw('web').map(([, d]) => (d as { baseUrl?: string }).baseUrl), ['https://jira.corp.local', undefined]);
  await k.unload();
});

test('security.setRoots: корень ФС, домашний каталог, каталоги приложения и не каталог - отказ', async () => {
  await using box = await sandbox();
  const file = path.join(box.work, 'f.txt');
  await writeFile(file, '');
  const { k, os } = await kernel({ projects: { 'security.roots': true } }, { dataDir: box.data, tempDir: box.temp, appDir: box.root });
  const sec = os('projects').security!;
  for (const r of ['/', homedir(), box.data, file, path.join(box.work, 'нет')]) await assert.rejects(sec.setRoots([r]), { code: 'PermissionDenied' }, r);
  await k.unload();
  const free = await kernel({ projects: { 'security.roots': true } }, { dataDir: box.data, tempDir: box.temp });
  await free.os('projects').security!.setRoots([box.work]);
  await free.k.unload();
});

test('чужие каталоги плагинов и данные приложения закрыты даже при праве на всю область', async () => {
  await using box = await sandbox();
  const app = path.join(box.root, 'app');
  await mkdir(path.join(app, 'proj'), { recursive: true });
  await writeFile(path.join(app, 'settings.json'), '{}');
  await writeFile(path.join(app, 'proj', 'a.txt'), 'a');
  const { k, os } = await kernel(
    { a: { 'fs.read': [box.root], 'fs.write': [box.root] }, b: undefined },
    { dataDir: box.data, tempDir: box.temp, appDir: app, roots: () => [path.join(app, 'proj')] },
  );
  await os('b').fs.writeText(path.join(os('b').paths.data, 'token'), 's');
  await assert.rejects(os('a').fs.readText(path.join(os('b').paths.data, 'token')), { code: 'PermissionDenied' });
  await assert.rejects(os('a').fs.list(os('b').paths.temp), { code: 'PermissionDenied' });
  await assert.rejects(os('a').fs.readText(path.join(app, 'settings.json')), { code: 'PermissionDenied' });
  assert.equal(await os('a').fs.readText(path.join(app, 'proj', 'a.txt')), 'a');
  await k.unload();
});

test('fs.remove: каталог с .git внутри и корень области не удаляются; защищённый путь читается через предка', async () => {
  await using box = await sandbox();
  await mkdir(path.join(box.work, 'repo', '.git'), { recursive: true });
  await mkdir(path.join(box.work, 'plain'), { recursive: true });
  const guarded = path.join(box.work, 'cyborg.json');
  await writeFile(guarded, '{}');
  const { k, os } = await kernel({ w: { 'fs.read': [box.work], 'fs.write': [box.work] } }, { dataDir: box.data, tempDir: box.temp, protectedPaths: [guarded] });
  const fs = os('w').fs;
  await assert.rejects(fs.remove(path.join(box.work, 'repo')), { code: 'PermissionDenied' });
  await assert.rejects(fs.remove(box.work), { code: 'PermissionDenied' });
  await fs.remove(path.join(box.work, 'plain'));
  assert.deepEqual((await fs.list(box.work)).map((e) => e.name).sort(), ['cyborg.json', 'repo']);
  await k.unload();
});

test('права: маски путей, workspace.git, выбор в dialog как granted, shell - без исполняемых и только свои схемы', async () => {
  await using box = await sandbox();
  const logs = path.join(box.work, 'proj', 'logs');
  const deep = path.join(box.work, 'a', 'b', 'notes');
  for (const d of [logs, deep, path.join(box.work, 'proj', '.git')]) await mkdir(d, { recursive: true });
  await writeFile(path.join(logs, 'x.log'), 'лог');
  await writeFile(path.join(box.work, 'proj', 'secret.txt'), 'нет');
  const picked = path.join(box.outside, 'picked.txt');
  const tool = path.join(box.outside, 'tool');
  for (const [f, text] of [[picked, 'выбран'], [path.join(box.outside, 'run.sh'), '#!/bin/sh'], [path.join(box.outside, 'doc.txt'), 'd'], [tool, '#!/bin/sh']]) await writeFile(f!, text!);
  await chmod(tool, 0o755);
  const opened: string[] = [];
  let pick: string[] = [];
  const { k, os, denied } = await kernel(
    {
      masks: { 'fs.read': [`${box.work}/*/logs`, `${box.work}/**/notes`], 'fs.write': [`${box.work}/*/logs`, `${box.work}/proj/*`] },
      git: { 'fs.write': ['workspace.git'] },
      plain: { 'fs.write': ['workspace'] },
      picker: { 'fs.read': ['granted'], shell: ['granted', 'https:'] },
    },
    {
      dataDir: box.data,
      tempDir: box.temp,
      roots: () => [box.work],
      dialog: { open: async () => pick },
      shell: { openPath: async (p) => void opened.push(p), openExternal: async (u) => void opened.push(u) },
    },
  );
  assert.equal(await os('masks').fs.readText(path.join(logs, 'x.log')), 'лог');
  await assert.rejects(os('masks').fs.writeText(path.join(box.work, 'proj', '.git', 'config'), 'x'), { code: 'PermissionDenied' }, 'маска * совпала с .git');
  assert.deepEqual(await os('masks').fs.list(deep), []);
  await assert.rejects(os('masks').fs.readText(path.join(box.work, 'proj', 'secret.txt')), { code: 'PermissionDenied' });
  await assert.rejects(os('masks').fs.remove(logs), { code: 'PermissionDenied' }, 'каталог под маской - корень области');

  await os('git').fs.writeText(path.join(box.work, 'proj', '.git', 'HEAD'), 'ref');
  await assert.rejects(os('plain').fs.writeText(path.join(box.work, 'proj', '.git', 'HEAD'), 'x'), { code: 'PermissionDenied' });

  await assert.rejects(os('picker').fs.readText(picked), { code: 'PermissionDenied' });
  pick = [picked];
  assert.deepEqual(await os('picker').dialog.open({ title: 'Файл' }), [picked]);
  assert.equal(await os('picker').fs.readText(picked), 'выбран');
  await assert.rejects(os('masks').fs.readText(picked), { code: 'PermissionDenied' }, 'выбор одного плагина - не право другого');
  await assert.rejects(os('picker').dialog.open({ extra: 1 } as never), { code: 'Invalid' });

  const shell = os('picker').shell;
  if (typeof shell?.openPath !== 'function' || typeof shell.openExternal !== 'function') throw new Error('у picker нет shell.openPath и openExternal');
  assert.equal(os('masks').shell, undefined);
  await shell.openPath(picked);
  await shell.openExternal('https://example.com/a');
  await assert.rejects(shell.openExternal('mailto:a@b.c'), { code: 'PermissionDenied' });
  await assert.rejects(shell.openPath(path.join(box.outside, 'doc.txt')), { code: 'PermissionDenied' }, 'не выбран');
  pick = [path.join(box.outside, 'run.sh'), tool];
  await os('picker').dialog.open({ multiple: true });
  await assert.rejects(shell.openPath(path.join(box.outside, 'run.sh')), { code: 'PermissionDenied' }, 'исполняемый по расширению');
  const risky = ['a.webloc', 'a.terminal', 'a.REG', 'a.py'].map((name) => path.join(box.outside, name));
  for (const file of risky) await writeFile(file, '');
  pick = risky;
  await os('picker').dialog.open({ multiple: true });
  for (const file of risky) await assert.rejects(shell.openPath(file), { code: 'PermissionDenied' }, `ярлык или скрипт: ${file}`);
  if (process.platform !== 'win32') await assert.rejects(shell.openPath(tool), { code: 'PermissionDenied' }, 'исполняемый по биту');
  assert.deepEqual(opened, [picked, 'https://example.com/a']);
  assert.ok(denied().includes('picker:shell.openExternal'));
  await k.unload();
});

test('shell.openPath: где плагин сам пишет, открывается только документ - файл с неизвестным расширением не запустится', async () => {
  await using box = await sandbox();
  const proj = path.join(box.work, 'proj');
  await mkdir(path.join(proj, 'reports'), { recursive: true });
  const opened: string[] = [];
  const { k, os, denied } = await kernel(
    {
      writer: { 'fs.write': ['workspace'], shell: ['workspace', 'plugin-data'] },
      viewer: { 'fs.read': ['workspace'], shell: ['workspace'] },
    },
    { dataDir: box.data, tempDir: box.temp, roots: () => [box.work], shell: { openPath: async (p) => void opened.push(p), openExternal: async () => undefined } },
  );
  const writer = os('writer');
  const opener = (id: string) => {
    const shell = os(id).shell;
    if (typeof shell?.openPath !== 'function') throw new Error(`у ${id} нет shell.openPath`);
    return (file: string) => shell.openPath!(file);
  };
  const open = opener('writer');
  const payload = path.join(proj, 'payload.xyz');
  const report = path.join(proj, 'reports', 'report.MD');
  const own = path.join(writer.paths.data, 'out.pdf');
  for (const [file, text] of [[payload, 'код'], [report, '# отчёт'], [own, '%PDF'], [path.join(writer.paths.data, 'page.html'), '<script>']] as const) await writer.fs.writeText(file, text);

  await assert.rejects(open(payload), { code: 'PermissionDenied' }, 'неизвестный тип в области записи');
  await assert.rejects(open(path.join(writer.paths.data, 'page.html')), { code: 'PermissionDenied' }, 'страница выполнит скрипт в браузере');
  await assert.rejects(open(path.join(proj, 'reports')), { code: 'PermissionDenied' }, 'каталог - не документ');
  await open(report);
  await open(own);
  assert.ok(denied().includes('writer:shell.openPath'));

  await opener('viewer')(payload);
  assert.deepEqual(opened, [report, own, payload]);
  assert.deepEqual(describePermissions({ 'fs.read': ['workspace'], shell: ['workspace'] }), ['читает файлы: проекты воркспейса', 'открывает в системе: проекты воркспейса - кроме программ и скриптов']);
  assert.ok(describePermissions({ shell: ['plugin-data'] }).includes('открывает в системе: свои данные - кроме программ и скриптов; где сам пишет - только документы'));
  await k.unload();
});

test('shell any: документ или каталог вне корней; программа, файл не документом, пропавший путь, защищённое и чужое - отказ; читать area any не даёт', async () => {
  await using box = await sandbox();
  const guarded = path.join(box.work, 'team.cyborg.json');
  const doc = path.join(box.outside, 'build.log');
  const program = path.join(box.outside, 'run');
  const script = path.join(box.outside, 'setup.sh');
  const page = path.join(box.outside, 'page.html');
  const payload = path.join(box.outside, 'payload.xyz');
  for (const f of [guarded, doc, program, script, page, payload]) await writeFile(f, 'x');
  await chmod(program, 0o755);
  const opened: string[] = [];
  const { k, os, denied } = await kernel(
    { linker: { shell: ['any'] }, narrow: { shell: ['workspace'] }, other: { 'fs.write': ['plugin-data'] } },
    { dataDir: box.data, tempDir: box.temp, roots: () => [box.work], protectedPaths: [guarded], shell: { openPath: async (p) => void opened.push(p), openExternal: async () => undefined } },
  );
  const opener = (id: string) => {
    const shell = os(id).shell;
    if (typeof shell?.openPath !== 'function') throw new Error(`у ${id} нет shell.openPath`);
    return (file: string) => shell.openPath!(file);
  };
  const open = opener('linker');
  await open(doc);
  await open(box.outside);
  await assert.rejects(open(program), { code: 'PermissionDenied' }, 'файл с битом x');
  await assert.rejects(open(script), { code: 'PermissionDenied' }, 'скрипт по расширению');
  await assert.rejects(open(page), { code: 'PermissionDenied' }, 'страницу мог положить кто угодно, браузер выполнит её скрипт');
  await assert.rejects(open(payload), { code: 'PermissionDenied' }, 'тип не из списка документов');
  await assert.rejects(open(path.join(box.outside, 'gone.txt')), { code: 'NotFound' });
  await assert.rejects(open(guarded), { code: 'PermissionDenied' }, 'защищённый путь');
  const foreign = path.join(os('other').paths.data, 'note.txt');
  await os('other').fs.writeText(foreign, 'x');
  await assert.rejects(open(foreign), { code: 'PermissionDenied' }, 'каталог другого плагина');
  const own = path.join(os('linker').paths.data, 'payload.xyz');
  await os('linker').fs.writeText(own, 'x');
  await assert.rejects(open(own), { code: 'PermissionDenied' }, 'там, где пишет сам, - только документ');
  await assert.rejects(opener('narrow')(doc), { code: 'PermissionDenied' }, 'без области any - вне области');
  assert.deepEqual(opened, [doc, box.outside]);
  assert.ok(denied().includes('narrow:shell.openPath'));
  await assert.rejects(os('linker').fs.readText(doc), { code: 'PermissionDenied' }, 'any не даёт чтения');
  await k.unload();

  assert.deepEqual(describePermissions({ shell: ['any'] }), ['открывает в системе: любой документ или каталог - кроме программ и скриптов; где сам пишет - только документы']);
  for (const right of ['fs.read', 'fs.write']) {
    const r = parseManifest(manifest('p', { [right]: ['any'] }));
    assert.ok(!r.ok && r.errors.some((e) => e.startsWith(`permissions.${right}`)), right);
  }
});

test('команда ядра cyborg.workspace.reveal: среда показывает файл воркспейса, плагину файл закрыт и команда недоступна', async () => {
  await using box = await sandbox();
  const file = path.join(box.work, 'team.cyborg.json');
  await writeFile(file, '{}');
  const shown: string[] = [];
  const { k, os, ctx } = await kernel(
    { reader: { 'fs.read': ['workspace'], shell: ['workspace'] } },
    { dataDir: box.data, tempDir: box.temp, roots: () => [box.work], protectedPaths: [file], workspaceFile: file, shell: { openPath: async () => undefined, openExternal: async () => undefined, showItemInFolder: (p) => void shown.push(p) } },
  );
  await k.run('cyborg.workspace.reveal');
  assert.deepEqual(shown, [file]);
  await assert.rejects(os('reader').fs.readText(file), { code: 'PermissionDenied' }, 'файл воркспейса - защищённый путь');
  await assert.rejects(ctx('reader').commands.run('cyborg.workspace.reveal'), { code: 'PermissionDenied' }, 'команду ядра зовёт приложение');
  await assert.rejects(k.runOwn('reader', 'cyborg.workspace.reveal'), { code: 'PermissionDenied' }, 'вид и уведомление плагина команду ядра не зовут');
  assert.deepEqual(shown, [file]);
  await k.unload();

  const bare = await kernel({}, { dataDir: box.data, tempDir: box.temp });
  await assert.rejects(bare.k.run('cyborg.workspace.reveal'), { code: 'Unavailable' });
  await bare.k.unload();
});

test('granted: выбор в dialog лежит в state воркспейса и действует после перезапуска; кривые записи и сбой записи не мешают', async () => {
  await using box = await sandbox();
  const [picked, kept, late] = ['picked.txt', 'kept.txt', 'late.txt'].map((name) => path.join(box.outside, name));
  for (const f of [picked!, kept!, late!]) await writeFile(f, 'текст');
  const [realPicked, realKept] = await Promise.all([picked!, kept!].map((f) => realpath(f)));
  let doc: Record<string, unknown> = { $granted: { $version: 1, byPlugin: { other: [realKept, 'relative/x', 42, '/a\0b'], ghost: 'не список' } } };
  let failSave = false;
  const store: LayerStore = {
    load: async () => structuredClone(doc),
    save: async (_layer, next) => {
      if (failSave) throw new Error('диск полон');
      doc = structuredClone(next);
    },
  };
  let pick: string[] = [];
  const start = async () => {
    const contexts = new Map<string, PluginContext>();
    const k = await load({
      apiVersion: PLUGIN_API_VERSION,
      spawnHost: inlineHosts(async (entry) => ({ activate: (ctx: PluginContext) => void contexts.set(entry, ctx) })),
      enabled: ['picker', 'other'],
      manifests: [manifest('picker', { 'fs.read': ['granted'] }), manifest('other', { 'fs.read': ['granted'] })],
      os: { dataDir: box.data, tempDir: box.temp, dialog: { open: async () => pick } },
      state: await SectionStore.open(store, ['workspace']),
    });
    return { k, os: (id: string) => contexts.get(id)!.os };
  };

  const first = await start();
  assert.equal(await first.os('other').fs.readText(kept!), 'текст', 'сохранённое прочитано при старте');
  await assert.rejects(first.os('picker').fs.readText(picked!), { code: 'PermissionDenied' });
  pick = [picked!];
  await first.os('picker').dialog.open({});
  await first.k.unload();
  assert.deepEqual(doc.$granted, { $version: 1, byPlugin: { other: [realKept], picker: [realPicked] } }, 'кривые записи при сохранении отсеяны');

  const second = await start();
  assert.equal(await second.os('picker').fs.readText(picked!), 'текст');
  await assert.rejects(second.os('other').fs.readText(picked!), { code: 'PermissionDenied' }, 'выбор одного плагина - не право другого');
  failSave = true;
  pick = [late!];
  assert.deepEqual(await second.os('picker').dialog.open({}), [late], 'сбой записи не отменяет выбор человека');
  assert.equal(await second.os('picker').fs.readText(late!), 'текст');
  assert.deepEqual((doc.$granted as { byPlugin: Record<string, string[]> }).byPlugin.picker, [realPicked]);
  await second.k.unload();
});

test('env правила: маска имени `ПРЕФИКС_*` принимается манифестом, звёздочка в иных местах - ошибка; права словами называют маску', () => {
  const rule = (env: unknown) => ({ process: [{ program: 'git', args: [], env }] });
  const ok = parseManifest(manifest('p', rule(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_*', 'GIT_CONFIG_VALUE_*'])));
  assert.ok(ok.ok);
  assert.deepEqual(describePermissions(ok.manifest.permissions), ['запускает программы: git (окружение: GIT_CONFIG_COUNT, GIT_CONFIG_KEY_*, GIT_CONFIG_VALUE_*) - полный доступ через программу']);
  for (const bad of [['*'], ['GIT*'], ['GIT_*_X'], ['_*'], ['GIT_CONFIG_*_*'], ['*_KEY'], ['1_*'], [' GIT_*']]) assert.equal(parseManifest(manifest('p', rule(bad))).ok, false, JSON.stringify(bad));
  assert.equal(parseManifest(manifest('p', { env: ['GIT_CONFIG_KEY_*'] })).ok, false, 'право env.get маски не принимает: читать можно только названную переменную');
});

test('env правила: маска ПРЕФИКС_* покрывает только номерной хвост - GIT_CONFIG_KEY_X, GIT_SSH_COMMAND и LD_PRELOAD под неё не проходят', async () => {
  assert.equal(envNameAllowed('GIT_CONFIG_KEY_*', 'GIT_CONFIG_KEY_0'), true);
  assert.equal(envNameAllowed('GIT_CONFIG_KEY_*', 'GIT_CONFIG_KEY_12'), true);
  for (const name of ['GIT_CONFIG_KEY_X', 'GIT_CONFIG_KEY_', 'GIT_CONFIG_KEY_1a', 'GIT_CONFIG_KEY', 'GIT_CONFIG_KEY_-1']) assert.equal(envNameAllowed('GIT_CONFIG_KEY_*', name), false, name);
  assert.equal(envNameAllowed('GIT_*', 'GIT_SSH_COMMAND'), false);
  assert.equal(envNameAllowed('LD_*', 'LD_PRELOAD'), false);
  assert.equal(envNameAllowed('GIT_CONFIG_COUNT', 'GIT_CONFIG_COUNT'), true);
  await using box = await sandbox();
  const rule = { program: process.execPath, args: ['-e'], env: ['GIT_CONFIG_KEY_*', 'LD_*'] };
  const { k, os, denied } = await kernel({ vcs: { process: [rule] } }, { dataDir: box.data, tempDir: box.temp });
  for (const name of ['GIT_CONFIG_KEY_X', 'LD_PRELOAD']) await assert.rejects(os('vcs').process!.run(process.execPath, ['-e', '0'], { env: { [name]: '1' } }), { code: 'PermissionDenied' }, name);
  assert.equal((await os('vcs').process!.run(process.execPath, ['-e', '0'], { env: { GIT_CONFIG_KEY_3: 'a' } })).code, 0);
  assert.equal(denied().length, 2);
  await k.unload();
});

test('env правила: программа получает GIT_CONFIG_COUNT, KEY_<n>, VALUE_<n> через маску и применяет их', async () => {
  await using box = await sandbox();
  const rule = { program: process.execPath, args: ['-e'], env: ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_*', 'GIT_CONFIG_VALUE_*'] };
  const { k, os } = await kernel({ vcs: { process: [rule] } }, { dataDir: box.data, tempDir: box.temp });
  const env = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'filter.lfs.clean', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'filter.lfs.required', GIT_CONFIG_VALUE_1: 'false' };
  const got = await os('vcs').process!.run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.entries(process.env).filter(([k]) => k.startsWith("GIT_CONFIG_")).sort()))'], { env });
  assert.deepEqual(JSON.parse(got.stdout), Object.entries(env).sort());
  await k.unload();
});

const gatewayFor = (env: OsEnvironment, grants?: ConstructorParameters<typeof OsGateway>[5]) => new OsGateway(env, () => undefined, undefined, undefined, undefined, grants);

test('uninstall, шлюз: eraseFiles стирает data и temp только этого id, ссылка не ведёт наружу, чужие каталоги целы', async () => {
  await using box = await sandbox();
  const gateway = gatewayFor({ dataDir: box.data, tempDir: box.temp });
  for (const [dir, id] of [[box.data, 'jira'], [box.temp, 'jira'], [box.data, 'jira2'], [box.data, 'jira.sub'], [box.temp, 'other']] as const) {
    await mkdir(path.join(dir, id, 'deep'), { recursive: true });
    await writeFile(path.join(dir, id, 'deep', 'f.txt'), id);
  }
  assert.deepEqual(await gateway.eraseFiles('jira'), ['данные плагина (plugin-data)', 'временные файлы (plugin-temp)']);
  for (const gone of [path.join(box.data, 'jira'), path.join(box.temp, 'jira')]) await assert.rejects(stat(gone), { code: 'ENOENT' });
  for (const kept of [path.join(box.data, 'jira2'), path.join(box.data, 'jira.sub'), path.join(box.temp, 'other')]) assert.equal((await stat(kept)).isDirectory(), true, kept);
  assert.deepEqual(await gateway.eraseFiles('jira'), [], 'повтор ничего не находит');

  // Каталог плагина подменён ссылкой наружу: стирается ссылка, а не то, на что она указывает.
  await writeFile(path.join(box.outside, 'keep.txt'), 'нельзя');
  await symlink(box.outside, path.join(box.data, 'linked'));
  assert.deepEqual(await gateway.eraseFiles('linked'), ['данные плагина (plugin-data)']);
  await assert.rejects(lstat(path.join(box.data, 'linked')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(box.outside, 'keep.txt'), 'utf8'), 'нельзя');
});

test('uninstall, шлюз: недопустимый id не выводит за каталог данных и ничего не стирает', async () => {
  await using box = await sandbox();
  const gateway = gatewayFor({ dataDir: box.data, tempDir: box.temp });
  await mkdir(box.data, { recursive: true });
  await writeFile(path.join(box.root, 'precious.txt'), 'важное');
  for (const id of ['..', '../outside', 'a/../..', '/etc', '', '.', 'a/b', 'UP', 'a\0b', 'a b']) {
    await assert.rejects(gateway.eraseFiles(id), { code: 'Invalid' }, JSON.stringify(id));
    await assert.rejects(gateway.eraseSecrets(id), { code: 'Invalid' }, JSON.stringify(id));
  }
  assert.equal(await readFile(path.join(box.root, 'precious.txt'), 'utf8'), 'важное');
  assert.equal((await stat(box.outside)).isDirectory(), true);
  assert.equal((await stat(box.data)).isDirectory(), true);
});

test('uninstall, шлюз: eraseSecrets стирает ключи <id>/ даже без шифрования ОС, соседи с общим началом целы', async () => {
  await using box = await sandbox();
  const store = memorySecrets(false);
  for (const k of ['jira/token', 'jira/a/b', 'jira2/token', 'jira.sub/token', 'other/jira/token']) store.map.set(k, 'v');
  const gateway = gatewayFor({ dataDir: box.data, tempDir: box.temp, secrets: store });
  assert.equal(await gateway.eraseSecrets('jira'), 2);
  assert.deepEqual([...store.map.keys()].sort(), ['jira.sub/token', 'jira2/token', 'other/jira/token']);
  assert.equal(await gatewayFor({ dataDir: box.data, tempDir: box.temp }).eraseSecrets('jira'), 0, 'хранилища нет - стирать нечего');
});

test('uninstall, шлюз: eraseGrants убирает выбор плагина из памяти и из state, чужой выбор цел', async () => {
  await using box = await sandbox();
  const written: Record<string, readonly string[]>[] = [];
  const grants = { read: () => ({ jira: [box.work], other: [box.outside] }), write: async (by: Record<string, readonly string[]>) => void written.push(by) };
  const gateway = gatewayFor({ dataDir: box.data, tempDir: box.temp }, grants);
  assert.equal(await gateway.eraseGrants('jira'), 1);
  assert.deepEqual(written, [{ other: [box.outside] }]);
  assert.equal(await gateway.eraseGrants('jira'), 0);
  assert.equal(written.length, 1, 'нечего стирать - нечего писать');
});

test('права в манифесте: маска под названным каталогом, workspace.git только у записи, shell без file:', () => {
  const errors = (permissions: unknown) => {
    const r = parseManifest(manifest('x', permissions));
    return r.ok ? [] : r.errors;
  };
  assert.deepEqual(errors({ 'fs.read': ['/a/*/b', '~/x/**', 'granted'], 'fs.write': ['workspace.git'], shell: ['https:', 'mailto:', 'workspace'] }), []);
  for (const bad of [{ 'fs.read': ['/*'] }, { 'fs.read': ['~/*/x'] }, { 'fs.read': ['/a/../b'] }, { 'fs.read': ['/a/x**'] }, { 'fs.read': ['workspace.git'] }, { shell: ['file:'] }, { shell: ['javascript:'] }, { shell: ['https'] }]) {
    assert.notDeepEqual(errors(bad), [], JSON.stringify(bad));
  }
  assert.ok(describePermissions({ shell: ['granted', 'https:'], 'fs.write': ['workspace.git'] }).includes('открывает в системе: выбранное человеком в диалоге, https: - кроме программ и скриптов; где сам пишет - только документы'));
});

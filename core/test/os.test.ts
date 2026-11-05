import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext, PluginOs } from '@cyborg/contracts';
import { SectionStore } from '../src/config.ts';
import { load } from '../src/loader.ts';
import { parseManifest } from '../src/manifest.ts';
import { describePermissions } from '../src/permissions.ts';
import type { OsEnvironment, SecretStore } from '../src/os-gateway.ts';
import { inlineHosts } from '../src/transports.ts';

const manifest = (id: string, permissions?: unknown) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...(permissions !== undefined && { permissions }) });

async function sandbox() {
  const root = await mkdtemp(path.join(tmpdir(), 'cyborg-os-'));
  const dirs = { data: path.join(root, 'data'), temp: path.join(root, 'temp'), work: path.join(root, 'work'), outside: path.join(root, 'outside') };
  for (const d of [dirs.work, dirs.outside]) await mkdir(d, { recursive: true });
  return { root, ...dirs, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}

function memorySecrets(available = true): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, available: () => available, get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v), delete: async (k) => void map.delete(k) };
}

/** Плагины отдают свой ctx наружу: тест зовёт ctx.os так же, как плагин. */
async function kernel(plugins: Record<string, unknown>, env: Partial<OsEnvironment> & Pick<OsEnvironment, 'dataDir' | 'tempDir'>, config?: Record<string, unknown>) {
  const contexts = new Map<string, PluginContext>();
  const k = await load({
    apiVersion: '1.0.0',
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

test('fs.read и fs.write: область по праву, симлинк наружу не пускает, .git и защищённые пути закрыты', async () => {
  await using box = await sandbox();
  await writeFile(path.join(box.outside, 'secret.txt'), 'нельзя');
  await writeFile(path.join(box.work, 'readme.md'), 'можно');
  await symlink(box.outside, path.join(box.work, 'escape'));
  await mkdir(path.join(box.work, '.git'));
  const workspaceFile = path.join(box.work, 'cyborg.json');
  await writeFile(workspaceFile, '{}');
  const { k, os } = await kernel(
    { reader: { 'fs.read': [box.work] }, writer: { 'fs.read': [box.work], 'fs.write': [box.work] } },
    { dataDir: box.data, tempDir: box.temp, protectedPaths: [workspaceFile] },
  );
  assert.equal(await os('reader').fs.readText(path.join(box.work, 'readme.md')), 'можно');
  await assert.rejects(os('reader').fs.readText(path.join(box.work, 'escape', 'secret.txt')), { code: 'PermissionDenied' });
  await assert.rejects(os('reader').fs.writeText(path.join(box.work, 'new.txt'), 'x'), { code: 'PermissionDenied' });
  await assert.rejects(os('reader').fs.readText(workspaceFile), { code: 'PermissionDenied' });
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

test('fs.watch: имена изменённых в каталоге склеены, снятие и выгрузка закрывают наблюдение, вне области - отказ', async () => {
  await using box = await sandbox();
  const { k, os } = await kernel({ reader: { 'fs.read': [box.work] } }, { dataDir: box.data, tempDir: box.temp });
  const fs = os('reader').fs;
  const batches: (readonly string[])[] = [];
  const sub = await fs.watch(box.work, (names) => batches.push(names));
  await writeFile(path.join(box.work, 'a.jsonl'), '1\n');
  await appendFile(path.join(box.work, 'a.jsonl'), '2\n');
  await writeFile(path.join(box.work, 'b.jsonl'), '1\n');
  for (let i = 0; i < 100 && !batches.flat().includes('b.jsonl'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([...new Set(batches.flat())].toSorted(), ['a.jsonl', 'b.jsonl']);
  assert.ok(batches.length < 4, `события не склеены: ${JSON.stringify(batches)}`);
  sub.dispose();
  await new Promise((r) => setTimeout(r, 100));
  const seen = batches.length;
  await writeFile(path.join(box.work, 'c.jsonl'), '1\n');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(batches.length, seen, 'после dispose событий нет');

  const fileEvents: (readonly string[])[] = [];
  await fs.watch(path.join(box.work, 'a.jsonl'), (names) => fileEvents.push(names));
  await appendFile(path.join(box.work, 'a.jsonl'), '3\n');
  for (let i = 0; i < 100 && fileEvents.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fileEvents.length > 0, 'дописанный файл не замечен');

  await assert.rejects(fs.watch(box.outside, () => undefined), { code: 'PermissionDenied' });
  await assert.rejects(fs.watch(path.join(box.work, 'нет'), () => undefined));
  await k.unload();
  await appendFile(path.join(box.work, 'a.jsonl'), '4\n');
  await new Promise((r) => setTimeout(r, 100));
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
  await writeFile(path.join(box.outside, 'a'), '1');
  for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen.flat(), ['a']);
  await os('projects').security!.setRoots([]);
  await writeFile(path.join(box.outside, 'b'), '1');
  await new Promise((r) => setTimeout(r, 200));
  await writeFile(path.join(box.outside, 'c'), '1');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(seen.flat(), ['a'], 'после сужения корней событий нет');
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
    apiVersion: '1.0.0',
    spawnHost: inlineHosts(async (entry) => ({ activate: (ctx: PluginContext) => void contexts.set(entry, ctx) })),
    enabled: ['web'],
    manifests: [{ ...manifest('web', { net: ['config:baseUrl'] }), config: { version: 1 } }],
    os: { dataDir: box.data, tempDir: box.temp },
    config: store,
  });
  const config = contexts.get('web')!.config!;
  await assert.rejects(config.set('user', { baseUrl: 'https://attacker.example', theme: 'dark' }), { code: 'PermissionDenied' });
  assert.ok(k.journal.some((e) => e.kind === 'denied' && e.method === 'config.set'));
  await config.set('user', { ...config.get(), theme: 'dark' });
  await config.set('workspace', { theme: 'light' });
  assert.deepEqual(store.raw('web').map(([, d]) => (d as { baseUrl?: string }).baseUrl), ['https://jira2.corp.local', undefined]);
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

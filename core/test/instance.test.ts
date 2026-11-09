import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimInstance, instanceAddress, instanceDir, type Claim } from '../src/instance.ts';

// K-20: по экземпляру на воркспейс. Второй запуск того же воркспейса просит первого поднять окно и уходит; разные воркспейсы не мешают друг другу.

const claimer = fileURLToPath(new URL('./fixtures/instance-claimer.ts', import.meta.url));
const posix = process.platform !== 'win32';

async function sandbox(base = tmpdir()) {
  // Короткий путь: адрес сокета unix ограничен ~104 байтами.
  const dir = await realpath(await mkdtemp(path.join(base, 'ci-')));
  return { dir, [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) };
}

const key = 'a1b2c3d4e5f60718';

/** Закрывает адрес владельца; у не-владельца закрывать нечего. Через параметр, а не по месту: `assert.equal(kind)` сужает тип, и проверка в тесте выглядит лишней. */
const release = (claim: Claim) => {
  if (claim.kind === 'owner') claim.close();
};

test('второй запуск того же воркспейса: владелец получает данные раньше, чем второй узнаёт об этом, второй уходит', async () => {
  await using box = await sandbox();
  const asked: unknown[] = [];
  const first = await claimInstance(key, { safeMode: false }, (data) => asked.push(data), { dir: box.dir });
  assert.equal(first.kind, 'owner');
  const second = await claimInstance(key, { safeMode: true }, () => assert.fail('второй стал владельцем'), { dir: box.dir });
  assert.equal(second.kind, 'handed');
  assert.deepEqual(asked, [{ safeMode: true }]);
  first.close();
});

test('разные воркспейсы - независимые владельцы', async () => {
  await using box = await sandbox();
  const a = await claimInstance('aaaaaaaaaaaaaaaa', {}, () => undefined, { dir: box.dir });
  const b = await claimInstance('bbbbbbbbbbbbbbbb', {}, () => undefined, { dir: box.dir });
  assert.deepEqual([a.kind, b.kind], ['owner', 'owner']);
  for (const c of [a, b]) release(c);
});

test('close отдаёт воркспейс: адрес свободен, следующий запуск - владелец', async () => {
  await using box = await sandbox();
  const first = await claimInstance(key, {}, () => undefined, { dir: box.dir });
  assert.ok(first.kind === 'owner');
  first.close();
  if (posix) assert.equal(existsSync(instanceAddress(key, box.dir)), false, 'файл сокета остался');
  const again = await claimInstance(key, {}, () => undefined, { dir: box.dir });
  assert.equal(again.kind, 'owner');
  again.close();
});

test('сбой обработчика владельца не оставляет второго без ответа', async () => {
  await using box = await sandbox();
  const first = await claimInstance(key, {}, () => { throw new Error('окна нет'); }, { dir: box.dir });
  const second = await claimInstance(key, {}, () => undefined, { dir: box.dir });
  assert.equal(second.kind, 'handed');
  release(first);
});

test('владелец жив, но молчит: второй не становится владельцем, а сообщает об этом в срок', async () => {
  await using box = await sandbox();
  const mute = net.createServer(() => undefined);
  await new Promise<void>((resolve) => mute.listen(instanceAddress(key, box.dir), resolve));
  const started = Date.now();
  const claim = await claimInstance(key, {}, () => undefined, { dir: box.dir, askTimeoutMs: 200 });
  mute.close();
  assert.equal(claim.kind, 'unresponsive');
  assert.ok(Date.now() - started < 3000);
});

test('адрес не перепутан между воркспейсами и каталог закрыт для других пользователей', { skip: !posix }, async () => {
  await using box = await sandbox();
  const sub = path.join(box.dir, 'run');
  const first = await claimInstance(key, {}, () => undefined, { dir: sub });
  assert.equal(statSync(sub).mode & 0o777, 0o700);
  assert.notEqual(instanceAddress(key, sub), instanceAddress('ffffffffffffffff', sub));
  release(first);
});

const start = (dir: string, label: string, holdMs?: number) => {
  const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', claimer, dir, key, label, ...(holdMs === undefined ? [] : [String(holdMs)])], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => lines.push(...chunk.split('\n').filter(Boolean)));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return { child, lines, exited };
};

const until = async (what: string, probe: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > end) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('шесть процессов стартуют разом: владелец один, остальные его просили', async (t) => {
  await using box = await sandbox();
  const procs = Array.from({ length: 6 }, (_, i) => start(box.dir, `p${String(i)}`));
  // Упавшая проверка не должна вешать прогон: лишний «владелец» ждёт stdin и держит тест живым.
  t.after(() => {
    for (const p of procs) p.child.kill('SIGKILL');
  });
  await until('все определились', () => procs.every((p) => p.lines.some((l) => l === 'owner' || l === 'handed' || l === 'unresponsive')));
  const kinds = procs.map((p) => p.lines.find((l) => l === 'owner' || l === 'handed' || l === 'unresponsive'));
  assert.deepEqual(kinds.filter((k) => k === 'owner').length, 1, `владельцев не один: ${kinds.join(',')}`);
  assert.deepEqual(kinds.filter((k) => k === 'handed').length, 5, `остальные не передали запрос: ${kinds.join(',')}`);
  const owner = procs[kinds.indexOf('owner')];
  assert.ok(owner);
  await until('владелец получил пять запросов', () => owner.lines.filter((l) => l.startsWith('asked ')).length === 5);
  owner.child.stdin.end();
  await Promise.all(procs.map((p) => p.exited));
});

test('сокет остался от убитого процесса: из шести стартующих владелец один, чужой живой сокет никто не удаляет', { skip: !posix }, async (t) => {
  await using box = await sandbox();
  const dead = start(box.dir, 'dead');
  await until('первый владелец', () => dead.lines.includes('owner'));
  dead.child.kill('SIGKILL');
  await dead.exited;
  assert.ok(existsSync(instanceAddress(key, box.dir)), 'нет устаревшего сокета для проверки');
  const procs = Array.from({ length: 6 }, (_, i) => start(box.dir, `p${String(i)}`));
  t.after(() => {
    for (const p of procs) p.child.kill('SIGKILL');
  });
  await until('все определились', () => procs.every((p) => p.lines.some((l) => l === 'owner' || l === 'handed' || l === 'unresponsive')));
  const kinds = procs.map((p) => p.lines.find((l) => l === 'owner' || l === 'handed' || l === 'unresponsive'));
  assert.deepEqual(kinds.filter((k) => k === 'owner').length, 1, `владельцев не один: ${kinds.join(',')}`);
  assert.deepEqual(kinds.filter((k) => k === 'handed').length, 5, `остальные не передали запрос: ${kinds.join(',')}`);
  procs[kinds.indexOf('owner')]?.child.stdin.end();
  await Promise.all(procs.map((p) => p.exited));
});

/** Подменяет окружение на время `run`; undefined снимает переменную. */
async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}

test('каталог адресов: XDG_RUNTIME_DIR (абсолютный) первым; без него личный `<home>/run`, а не общий tmp; длинный home или его отсутствие - tmpdir', { skip: !posix }, async () => {
  await withEnv({ XDG_RUNTIME_DIR: '/run/user/1000' }, () => {
    assert.equal(path.dirname(instanceDir('/home/a/.config/App')), '/run/user/1000');
  });
  await withEnv({ XDG_RUNTIME_DIR: undefined }, () => {
    assert.equal(instanceDir('/home/a/.config/App'), '/home/a/.config/App/run', 'без XDG_RUNTIME_DIR адреса должны лежать у пользователя, а не в предсказуемом каталоге общего tmp');
    const far = `/home/a/${'очень-длинный-каталог/'.repeat(8)}App`;
    assert.equal(path.dirname(instanceDir(far)), tmpdir(), 'адрес не влезает в предел sun_path - запасной tmpdir');
    assert.equal(path.dirname(instanceDir()), tmpdir(), 'home не задан - tmpdir');
  });
  await withEnv({ XDG_RUNTIME_DIR: 'относительный/путь' }, () => {
    assert.equal(instanceDir('/home/a/.config/App'), '/home/a/.config/App/run', 'относительный XDG_RUNTIME_DIR недействителен');
  });
});

test('claimInstance с home: каталог адресов создаётся в home и закрыт для других; заранее занятый чужой /tmp-каталог ему не мешает', { skip: !posix }, async () => {
  // Путь `home` + `/run/<ключ>.sock` должен влезть в предел адреса: на macOS `tmpdir()` для этого длинноват.
  await using box = await sandbox('/tmp');
  const home = box.dir;
  await withEnv({ XDG_RUNTIME_DIR: undefined }, async () => {
    const claim = await claimInstance(key, {}, () => undefined, { home });
    assert.equal(claim.kind, 'owner');
    assert.equal(statSync(path.join(home, 'run')).mode & 0o777, 0o700);
    assert.ok(existsSync(path.join(home, 'run', `${key}.sock`)));
    release(claim);
  });
});

test('ошибка сервера владельца после запуска (например EMFILE на accept) не становится неперехваченной', async (t) => {
  await using box = await sandbox();
  const real = net.createServer;
  let captured: net.Server | undefined;
  (net as { createServer: typeof net.createServer }).createServer = ((...args: Parameters<typeof net.createServer>) => (captured = real(...args))) as typeof net.createServer;
  t.after(() => ((net as { createServer: typeof net.createServer }).createServer = real));
  const claim = await claimInstance(key, {}, () => undefined, { dir: box.dir });
  assert.ok(captured);
  assert.doesNotThrow(() => captured?.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' })));
  release(claim);
});

test('EEXIST при привязке - адрес занят, а не сбой: процесс идёт спрашивать владельца', { skip: !posix }, async (t) => {
  await using box = await sandbox();
  const real = net.createServer;
  let first = true;
  (net as { createServer: typeof net.createServer }).createServer = ((...args: Parameters<typeof net.createServer>) => {
    const server = real(...args);
    if (first) {
      first = false;
      // Файл сокета появился между проверкой и привязкой: так сообщает об этом часть платформ.
      server.listen = (() => {
        queueMicrotask(() => server.emit('error', Object.assign(new Error('EEXIST'), { code: 'EEXIST' })));
        return server;
      }) as typeof server.listen;
    }
    return server;
  }) as typeof net.createServer;
  t.after(() => ((net as { createServer: typeof net.createServer }).createServer = real));
  const claim = await claimInstance(key, {}, () => undefined, { dir: box.dir });
  assert.equal(claim.kind, 'owner', 'EEXIST принят за сбой привязки');
  release(claim);
});

/** Файл сокета, оставшийся от убитого владельца: лежит, но никто не слушает. */
async function leaveStaleSocket(dir: string): Promise<void> {
  const dead = start(dir, 'dead');
  await until('первый владелец', () => dead.lines.includes('owner'));
  dead.child.kill('SIGKILL');
  await dead.exited;
  assert.ok(existsSync(instanceAddress(key, dir)), 'нет устаревшего сокета для проверки');
}

test('свежий файл сокета без слушателя - владелец ещё запускается (bind уже был, listen нет): не снимается раньше срока запуска', { skip: !posix }, async () => {
  await using box = await sandbox();
  await leaveStaleSocket(box.dir);
  const address = instanceAddress(key, box.dir);
  const created = statSync(address).ctimeMs;
  const claim = await claimInstance(key, {}, () => undefined, { dir: box.dir });
  const age = Date.now() - created;
  assert.equal(claim.kind, 'owner');
  assert.ok(age >= 480, `свежий сокет снят через ${String(age)} мс после создания, раньше срока запуска владельца (500 мс)`);
  release(claim);
});

test('снятие устаревшего сокета: между проверкой и удалением в окне не больше одного процесса (под замком)', { skip: !posix }, async (t) => {
  await using box = await sandbox();
  await leaveStaleSocket(box.dir);
  // Замок привязан к pid: взаимное исключение проверяется только между процессами, не между вызовами одного.
  const procs = Array.from({ length: 3 }, (_, i) => start(box.dir, `p${String(i)}`, 150));
  t.after(() => {
    for (const p of procs) p.child.kill('SIGKILL');
  });
  const decided = (p: ReturnType<typeof start>) => p.lines.find((l) => l === 'owner' || l === 'handed' || l === 'unresponsive');
  await until('все определились', () => procs.every((p) => decided(p) !== undefined));
  const windows = procs.flatMap((p) => p.lines.filter((l) => l.startsWith('window ')).map((l) => l.split(' ').slice(1).map(Number) as [number, number])).sort((a, b) => a[0] - b[0]);
  assert.ok(windows.length >= 1, 'ни один процесс не снимал сокет');
  for (let i = 1; i < windows.length; i++) assert.ok((windows[i]?.[0] ?? 0) >= (windows[i - 1]?.[1] ?? Infinity), `окна «проверил - удалил» пересеклись: ${JSON.stringify(windows)}`);
  assert.deepEqual(procs.map(decided).sort(), ['handed', 'handed', 'owner']);
  procs.find((p) => decided(p) === 'owner')?.child.stdin.end();
  await Promise.all(procs.map((p) => p.exited));
});

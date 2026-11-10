import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watch as watchFs } from 'node:fs';
import { appendFile, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { waitFor } from '../../core/test/wait-for.ts';
import { git, makeRepo, sandbox, startPilot, writeFiles, type Pilot } from './pilot-kit.ts';

// PL-04: дерево файлов в плагине files поверх fs.list, fs.stat и fs.watch шлюза, отметки от git и открытие файла в viewer - три плагина в трёх хостах-процессах (forkHosts), настоящий репозиторий.

type Entry = readonly [string, string, string | null];
interface NodeView {
  dir: string;
  watched: boolean;
  stale: boolean;
  entries: Entry[];
}
interface State {
  root: string | null;
  version: number;
  rootLost: string | null;
  watches: number;
  pending: boolean;
  counters: { list: number; stat: number; batches: number; relists: number; markRuns: number; evicted: number; resyncs: number };
  marks: Record<string, string>;
  nodes: Record<string, NodeView>;
}

const FILES = { 'a.txt': 'a\n', 'src/b.ts': 'b\n', 'src/deep/c.ts': 'c\n', 'docs/readme.md': '# r\n' };
const names = (node: NodeView | undefined): string[] => (node?.entries ?? []).map((e) => e[0]).toSorted();
const state = (p: Pilot): Promise<State> => p.k.run('files.state') as Promise<State>;
const nosy = { id: 'nosy', permissions: {} };
const ARMED = '.armed';

/**
 * macOS (FSEvents) начинает доставку не в тот миг, когда fs.watch вернулся: правка сразу после него пропадает (хвост #147). Как в core/test/os.test.ts, до проверки
 * пишем в наблюдаемые каталоги пробный файл, пока дерево о нём не узнает; потом убираем его и ждём, пока дерево успокоится.
 */
async function arm(p: Pilot, dirs: readonly string[]): Promise<void> {
  const seen = (st: State, dir: string) => names(st.nodes[dir]).includes(ARMED);
  let n = 0;
  await waitFor('слежение отозвалось на пробные записи', async () => {
    const st = await state(p);
    if (dirs.every((d) => seen(st, d))) return true;
    for (const d of dirs) if (!seen(st, d)) await writeFile(path.join(d, ARMED), String(n++));
    return undefined;
  });
  for (const d of dirs) await rm(path.join(d, ARMED));
  await waitFor('пробные файлы ушли из дерева', async () => {
    const st = await state(p);
    return dirs.every((d) => !seen(st, d)) && !st.pending ? true : undefined;
  });
}

async function started(files: Readonly<Record<string, string>> = FILES, ids: Parameters<typeof startPilot>[0]['ids'] = ['files', 'git', 'viewer'], watch?: Parameters<typeof startPilot>[0]['watch']) {
  const box = await sandbox('cyborg-pl04-');
  const repo = await makeRepo(box, files);
  const p = await startPilot({ box, repo, ids, probes: [nosy], ...(watch && { watch }) });
  const dispose = async () => {
    await p[Symbol.asyncDispose]();
    await box[Symbol.asyncDispose]();
  };
  return { box, repo, p, [Symbol.asyncDispose]: dispose };
}
const QUIET_MS = 500;

/**
 * Дерево устоялось: отметки запрошены, запросов в работе нет, и ни счётчики, ни число сырых событий не менялись QUIET_MS подряд.
 * Одного «запросов нет» мало: запоздалое событие (дубль от FSEvents после удаления пробного файла) запускает запрос позже, чем тест снял снимок,
 * и такой запрос подхватывал правку, сделанную уже после снимка (так упал тест нерекурсивного слежения на macOS).
 */
const settled = (p: Pilot, runs = 1) => {
  let last = '';
  let since = Date.now();
  return waitFor('дерево устоялось: отметки получены, запросов и событий нет', async () => {
    const st = await state(p);
    const key = `${JSON.stringify(st.counters)}/${String(st.version)}/${String(p.watches.raw)}`;
    if (key !== last || st.pending || st.counters.markRuns < runs) {
      last = key;
      since = Date.now();
      return undefined;
    }
    return Date.now() - since >= QUIET_MS ? true : undefined;
  });
};

test('files: дерево корня и раскрытие каталога идут через fs.list шлюза; .git скрыт; отметки приходят от git из другого хоста', async () => {
  await using s = await started();
  const { p, repo } = s;
  assert.equal(new Set([p.k.hostOf('files'), p.k.hostOf('git'), p.k.hostOf('viewer')]).size, 3, 'три плагина - три хоста');
  const rootNode = (await p.k.run('files.root', repo)) as NodeView;
  assert.deepEqual(names(rootNode), ['a.txt', 'docs', 'src']);
  assert.deepEqual(rootNode.entries.find((e) => e[0] === 'src')?.[1], 'dir');
  const src = (await p.k.run('files.expand', path.join(repo, 'src'))) as NodeView;
  assert.deepEqual(src.entries.map((e) => `${e[0]}:${e[1]}`).toSorted(), ['b.ts:file', 'deep:dir']);
  await arm(p, [repo, path.join(repo, 'src')]);

  await appendFile(path.join(repo, 'src', 'b.ts'), 'x\n');
  await writeFile(path.join(repo, 'new.txt'), 'n\n');
  const after = await waitFor('отметки git дошли до дерева', async () => {
    const st = await state(p);
    return st.marks['src/b.ts'] === 'modified' && st.marks['new.txt'] === 'untracked' && names(st.nodes[repo]).includes('new.txt') ? st : undefined;
  });
  const marked = (dir: string, name: string) => after.nodes[dir]?.entries.find((e) => e[0] === name)?.[2];
  assert.equal(marked(repo, 'src'), 'changed', 'каталог с изменением внутри отмечен по детям');
  assert.equal(marked(repo, 'docs'), null);
  assert.equal(marked(path.join(repo, 'src'), 'b.ts'), 'modified');
  assert.equal(marked(repo, 'new.txt'), 'untracked');
});

test('files: без событий нет ни одного вызова - ни fs.list, ни fs.stat, ни git; правка известного файла стоит одного stat и одного запроса отметок, без перечитывания каталога', async () => {
  await using s = await started();
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await p.k.run('files.expand', path.join(repo, 'src'));
  await arm(p, [repo, path.join(repo, 'src')]);
  await settled(p);
  const idle = await state(p);
  const gitBefore = (await p.gitRuns()).length;
  await new Promise((r) => setTimeout(r, 1500));
  const still = await state(p);
  assert.deepEqual(still.counters, idle.counters, 'простой: счётчики вызовов не сдвинулись');
  assert.equal((await p.gitRuns()).length, gitBefore, 'простой: git не запускался');

  await appendFile(path.join(repo, 'src', 'b.ts'), 'x\n');
  const changed = await waitFor('правка дошла до отметок', async () => {
    const st = await state(p);
    return st.marks['src/b.ts'] === 'modified' ? st : undefined;
  });
  assert.equal(changed.counters.stat - idle.counters.stat, 1, 'один stat на изменённое имя');
  assert.equal(changed.counters.list, idle.counters.list, 'каталог не перечитывался');
  assert.equal(changed.counters.relists, idle.counters.relists);
  assert.equal(changed.counters.markRuns - idle.counters.markRuns, 1, 'один запрос отметок на пачку');
  assert.equal((await p.gitRuns()).length - gitBefore, 1, 'один git status на пачку');
});

test('files: новый файл, удалённый файл, переименованный каталог - каждый узел обновляется по своим именам, соседние каталоги не трогаются', async () => {
  await using s = await started();
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await p.k.run('files.expand', path.join(repo, 'src'));
  await p.k.run('files.expand', path.join(repo, 'src', 'deep'));
  await p.k.run('files.expand', path.join(repo, 'docs'));
  await arm(p, [repo, path.join(repo, 'src'), path.join(repo, 'src', 'deep'), path.join(repo, 'docs')]);
  await settled(p);
  const docsBefore = (await state(p)).nodes[path.join(repo, 'docs')];

  await writeFile(path.join(repo, 'src', 'added.ts'), 'a');
  await waitFor('новый файл виден', async () => (names((await state(p)).nodes[path.join(repo, 'src')]).includes('added.ts') ? true : undefined));
  await rm(path.join(repo, 'src', 'added.ts'));
  await waitFor('удалённый файл ушёл', async () => (!names((await state(p)).nodes[path.join(repo, 'src')]).includes('added.ts') ? true : undefined));

  const live = (await state(p)).watches;
  await rename(path.join(repo, 'src', 'deep'), path.join(repo, 'src', 'deeper'));
  const renamed = await waitFor('переименование разобрано', async () => {
    const st = await state(p);
    return names(st.nodes[path.join(repo, 'src')]).includes('deeper') ? st : undefined;
  });
  assert.ok(!names(renamed.nodes[path.join(repo, 'src')]).includes('deep'));
  assert.equal(renamed.nodes[path.join(repo, 'src', 'deep')], undefined, 'узел ушедшего каталога забыт');
  assert.equal(renamed.watches, live - 1, 'слежение за ушедшим каталогом снято');
  assert.deepEqual(renamed.nodes[path.join(repo, 'docs')]?.entries, docsBefore?.entries, 'docs не менялся');
});

test('files: каталог под слежением удалён - слежение закрыто ядром, узел и поддерево забыты, родитель перечитан, ошибок нет', async () => {
  await using s = await started();
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await p.k.run('files.expand', path.join(repo, 'src'));
  await p.k.run('files.expand', path.join(repo, 'src', 'deep'));
  await arm(p, [repo, path.join(repo, 'src'), path.join(repo, 'src', 'deep')]);
  await rm(path.join(repo, 'src'), { recursive: true });
  const st = await waitFor('удаление разобрано', async () => {
    const cur = await state(p);
    return !names(cur.nodes[repo]).includes('src') && cur.nodes[path.join(repo, 'src')] === undefined ? cur : undefined;
  });
  assert.equal(st.nodes[path.join(repo, 'src', 'deep')], undefined);
  assert.equal(st.watches, 1, 'остался корень');
  assert.deepEqual(p.k.journal.filter((e) => e.kind === 'failed'), []);
  await assert.rejects(p.k.run('files.expand', path.join(repo, 'src')), /не показан в дереве/);
});

test('files: корень удалён - rootLost с причиной, а не тишина', async () => {
  await using s = await started();
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await arm(p, [repo]);
  await rm(repo, { recursive: true });
  const st = await waitFor('потеря корня замечена', async () => {
    const cur = await state(p);
    return cur.rootLost === null ? undefined : cur;
  });
  assert.match(st.rootLost ?? '', /исчез|прерван|вне|прав|удал/i);
  assert.equal(st.watches, 0);
});

test('files: слежение не рекурсивное и ограничено 64 на плагин - дерево шире предела вытесняет давно раскрытые, не падает; вытесненный перечитывается при раскрытии', async () => {
  const wide = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`d${String(i).padStart(2, '0')}/f.txt`, 'x']));
  await using s = await started(wide, ['files']);
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  const dirs = Array.from({ length: 70 }, (_, i) => path.join(repo, `d${String(i).padStart(2, '0')}`));
  for (const dir of dirs) await p.k.run('files.expand', dir);
  const full = await state(p);
  assert.equal(full.watches, 64, 'шлюзу 64 из 64: корень и 63 новейших каталога');
  assert.ok(p.watches.peak <= 64, `одновременно открытых слежений ${String(p.watches.peak)} - предел шлюза не превышен`);
  assert.equal(full.counters.evicted, 7);
  const stale = Object.values(full.nodes).filter((n) => n.stale).map((n) => path.basename(n.dir)).toSorted();
  assert.deepEqual(stale, dirs.slice(0, 7).map((d) => path.basename(d)), 'вытеснены самые давние');
  assert.deepEqual(p.k.journal.filter((e) => e.kind === 'failed'), []);

  await arm(p, [dirs[69] ?? '']);
  // Новейший каталог следит: правка видна. Вытесненный молчит: правка не видна, пока его не раскроют снова.
  await writeFile(path.join(dirs[69] ?? '', 'new.txt'), 'n');
  await writeFile(path.join(dirs[0] ?? '', 'new.txt'), 'n');
  await waitFor('правка в слежении видна', async () => (names((await state(p)).nodes[dirs[69] ?? '']).includes('new.txt') ? true : undefined));
  assert.ok(!names((await state(p)).nodes[dirs[0] ?? '']).includes('new.txt'), 'вытесненный узел о правке не знает');
  const reopened = (await p.k.run('files.expand', dirs[0])) as NodeView;
  assert.ok(names(reopened).includes('new.txt'));
  assert.equal(reopened.watched, true);
  assert.equal((await state(p)).watches, 64);
});

test('files: checkout ветки с сотнями изменений - событий сколько угодно, обновлений и запросов git единицы, дерево совпадает с диском, отметки пусты', async (t) => {
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, d) => Array.from({ length: 20 }, (_, f) => [`d${String(d).padStart(2, '0')}/f${String(f).padStart(2, '0')}.txt`, `main ${String(d)} ${String(f)}\n`] as const)).flat());
  await using s = await started(many);
  const { p, repo } = s;
  git(repo, 'checkout', '-q', '-b', 'other');
  await writeFiles(repo, Object.fromEntries(Object.keys(many).map((f) => [f, 'other\n'])));
  for (let d = 0; d < 30; d++) await rm(path.join(repo, `d${String(d).padStart(2, '0')}`, 'f00.txt'));
  await writeFiles(repo, { 'extra/new.txt': 'n\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'other');
  git(repo, 'checkout', '-q', 'main');
  await p.k.run('files.root', repo);
  const expanded = Array.from({ length: 20 }, (_, d) => path.join(repo, `d${String(d).padStart(2, '0')}`));
  for (const dir of expanded) await p.k.run('files.expand', dir);
  await arm(p, [repo, ...expanded]);
  await settled(p);
  const before = await state(p);
  const gitBefore = (await p.gitRuns()).length;
  const rawBefore = p.watches.raw;

  git(repo, 'checkout', '-q', 'other');
  await waitFor('дерево совпало с веткой other', async () => {
    const st = await state(p);
    return names(st.nodes[repo]).includes('extra') && !names(st.nodes[path.join(repo, 'd00')]).includes('f00.txt') ? st : undefined;
  });
  await new Promise((r) => setTimeout(r, 1200));
  const after = await state(p);
  const raw = p.watches.raw - rawBefore;
  const runs = (await p.gitRuns()).length - gitBefore;
  t.diagnostic(`событий слежения ${String(raw)}, пачек ${String(after.counters.batches)}, перечитываний ${String(after.counters.relists)}, запросов отметок ${String(after.counters.markRuns - before.counters.markRuns)}, git status ${String(runs)}`);
  assert.ok(raw >= 20, `событий слежения ${String(raw)}`);
  assert.ok(after.counters.markRuns - before.counters.markRuns <= 6, `запросов отметок ${String(after.counters.markRuns - before.counters.markRuns)}`);
  assert.ok(runs <= 8, `git status запущен ${String(runs)} раз`);
  assert.ok(after.counters.batches < raw, `пачек ${String(after.counters.batches)} меньше событий ${String(raw)}: склейка работает`);
  assert.deepEqual(after.marks, {}, 'ветка совпадает с коммитом: отметок нет');
  for (let d = 0; d < 20; d++) {
    const dir = path.join(repo, `d${String(d).padStart(2, '0')}`);
    assert.ok(!names(after.nodes[dir]).includes('f00.txt'), `${dir}: удалённый файл ушёл`);
    assert.equal(names(after.nodes[dir]).length, 19);
  }
  assert.equal((await p.k.run('files.state') as State).watches, 21, 'корень и 20 раскрытых; checkout слежений не потерял');
  assert.deepEqual(p.k.journal.filter((e) => e.kind === 'failed'), []);
});

test('files: коммит снаружи сбрасывает отметки без единого события рабочего дерева - их приносит onChange поставщика', async () => {
  await using s = await started();
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await arm(p, [repo]);
  await appendFile(path.join(repo, 'a.txt'), 'x\n');
  await waitFor('отметка появилась', async () => ((await state(p)).marks['a.txt'] === 'modified' ? true : undefined));
  const batches = (await state(p)).counters.batches;
  git(repo, 'commit', '-q', '-a', '-m', 'second');
  await waitFor('отметка снята после коммита', async () => (Object.keys((await state(p)).marks).length === 0 ? true : undefined));
  assert.ok(((await state(p)).counters.batches) - batches <= 1, 'каталоги дерева при коммите почти не шумят');
});

test('files: слежение не рекурсивное - правка вглубь нераскрытого каталога не даёт события и отметки, пока что-то другое не запросит состояние (предел, ради которого нужна рекурсия в шлюзе)', async () => {
  await using s = await started();
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await arm(p, [repo]);
  await settled(p);
  const quiet = await state(p);
  const rawBefore = p.watches.raw;
  await appendFile(path.join(repo, 'src', 'deep', 'c.ts'), 'x\n');
  await new Promise((r) => setTimeout(r, 1500));
  const later = await state(p);
  assert.equal(p.watches.raw, rawBefore, 'корень не получил события о правке на два уровня глубже');
  assert.deepEqual(later.marks, {}, 'отметка правки в нераскрытом каталоге не появилась');
  assert.equal(later.counters.markRuns, quiet.counters.markRuns);

  // Любое другое событие (файл в корне) тянет свежий git status, и скрытая правка попадает в отметки: git её знает, дерево о ней не узнало само.
  await writeFile(path.join(repo, 'trigger.txt'), 't');
  const seen = await waitFor('отметки обновились по другой причине', async () => {
    const st = await state(p);
    return st.marks['trigger.txt'] === undefined ? undefined : st;
  });
  assert.equal(seen.marks['src/deep/c.ts'], 'modified');
  assert.equal(seen.nodes[repo]?.entries.find((e) => e[0] === 'src')?.[2], 'changed');
});

/** Слежение, которое теряет события, как FSEvents при лавине (на checkout большого репозитория корень не назвал три из шести ушедших каталогов). */
function lossy(drop: (target: string) => boolean): NonNullable<Parameters<typeof startPilot>[0]['watch']> {
  return ((target: string, listener: (event: string, name: string | null) => void) =>
    watchFs(target, (event, name) => {
      if (!drop(target)) listener(event, name);
    })) as unknown as NonNullable<Parameters<typeof startPilot>[0]['watch']>;
}

test('files: ОС потеряла события каталогов при checkout - дерево догоняет по оповещению git об индексе и голове', async () => {
  const drop = { on: false };
  await using s = await started(FILES, ['files', 'git', 'viewer'], lossy((target) => drop.on && !target.endsWith('.git')));
  const { p, repo } = s;
  git(repo, 'checkout', '-q', '-b', 'other');
  await rm(path.join(repo, 'docs'), { recursive: true });
  await writeFiles(repo, { 'extra/new.txt': 'n\n', 'src/more.ts': 'm\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'other');
  git(repo, 'checkout', '-q', 'main');
  await p.k.run('files.root', repo);
  await p.k.run('files.expand', path.join(repo, 'src'));
  await p.k.run('files.expand', path.join(repo, 'docs'));
  await arm(p, [repo, path.join(repo, 'src'), path.join(repo, 'docs')]);
  await settled(p);

  drop.on = true;
  git(repo, 'checkout', '-q', 'other');
  const st = await waitFor('дерево догнало диск без событий каталогов', async () => {
    const cur = await state(p);
    return names(cur.nodes[repo]).includes('extra') && !names(cur.nodes[repo]).includes('docs') && names(cur.nodes[path.join(repo, 'src')]).includes('more.ts') ? cur : undefined;
  });
  assert.equal(st.nodes[path.join(repo, 'docs')], undefined, 'узел ушедшего каталога забыт');
  // Счётчик перечитываний не проверяется: дерево могло догнать и по закрытию слежения за ушедшим каталогом (onClose шлюза), ждём наблюдаемый итог, а не путь к нему.
});

test('files: лавина событий, из которых ОС доставила только начало - после тишины перечитываются все узлы', async () => {
  const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`bulk/f${String(i).padStart(3, '0')}.txt`, 'x']));
  const gate = { left: Infinity };
  const drop = (target: string): boolean => {
    if (!target.endsWith('/bulk')) return false;
    gate.left--;
    return gate.left < 0;
  };
  await using s = await started({ ...FILES, 'bulk/keep.txt': 'k' }, ['files'], lossy(drop));
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await p.k.run('files.expand', path.join(repo, 'bulk'));
  await arm(p, [repo, path.join(repo, 'bulk')]);
  // Лавина тремя волнами по 50 файлов: слежение доставит события первых файлов первой волны, остальное потеряет; перечитанный по первой пачке каталог дальше не обновится.
  gate.left = 60;
  const waves = [0, 1, 2].map((w) => Object.fromEntries(Object.entries(many).slice(w * 50, w * 50 + 50)));
  for (const wave of waves) {
    await writeFiles(repo, wave);
    await new Promise((r) => setTimeout(r, 120));
  }
  const st = await waitFor('каталог перечитан после лавины', async () => {
    const cur = await state(p);
    return names(cur.nodes[path.join(repo, 'bulk')]).length === 151 ? cur : undefined;
  });
  assert.ok(st.counters.resyncs >= 1, 'перечитывание после тишины');
});

test('files: права - корень вне воркспейса отказан, ссылка наружу не раскрывается и не читается, ссылка внутрь читается; открывает файл только viewer и только по праву вызывающего', async () => {
  await using s = await started();
  const { p, repo, box } = s;
  const outside = box.path('outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'секрет');
  await symlink(outside, path.join(repo, 'out'));
  await symlink(path.join(repo, 'src', 'b.ts'), path.join(repo, 'in.ts'));
  const rootNode = (await p.k.run('files.root', repo)) as NodeView;
  const kinds = Object.fromEntries(rootNode.entries.map((e) => [e[0], e[1]]));
  assert.equal(kinds.out, 'link');
  assert.equal(kinds['in.ts'], 'link');
  await assert.rejects(p.k.run('files.expand', path.join(repo, 'out')), /ссылк/);
  await assert.rejects(p.k.run('files.root', '/etc'), { code: 'PermissionDenied', message: /вне области fs\.read/ });

  // Открытие: свой файл и ссылка внутрь - читаются; ссылка наружу и чужой путь - PermissionDenied от ядра, viewer ничего не прочитал.
  await p.k.run('files.root', repo);
  assert.deepEqual(await p.k.run('files.open', path.join(repo, 'a.txt')), { path: path.join(repo, 'a.txt'), size: 2, shownBytes: 2, truncated: false });
  assert.deepEqual(await p.k.run('files.open', path.join(repo, 'in.ts')), { path: path.join(repo, 'in.ts'), size: 2, shownBytes: 2, truncated: false });
  for (const target of [path.join(repo, 'out', 'secret.txt'), '/etc/hosts']) await assert.rejects(p.k.run('files.open', target), /вне области fs\.read/);
  assert.equal(((await p.k.run('viewer.current')) as { path: string }).path, path.join(repo, 'in.ts'), 'отказанные открытия viewer не затронули');
  const denied = p.k.journal.filter((e) => e.kind === 'denied');
  assert.ok(denied.some((e) => e.pluginId === 'files' && e.reason === 'via-contract'), 'отказ files записан у вызывающего с причиной via-contract');

  // Плагин без права читать путь: команда viewer.open ему открыта, но guard отказывает до viewer; команды files чужим плагинам закрыты.
  await assert.rejects(p.k.run('nosy.run', 'viewer.open', { path: path.join(repo, 'a.txt') }), /вне области fs\.read/);
  await assert.rejects(p.k.run('nosy.run', 'files.root', repo), /не открыл команду другим плагинам/);
  assert.ok(p.k.journal.some((e) => e.kind === 'denied' && e.pluginId === 'nosy' && e.reason === 'via-contract'));
  assert.ok(p.k.journal.some((e) => e.kind === 'denied' && e.pluginId === 'nosy' && e.reason === 'command-callers'));
});

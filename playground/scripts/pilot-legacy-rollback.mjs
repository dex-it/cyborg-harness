// Проверка пилота PL-06: что видит старая версия Cyborg (ai-cyborg, коммит e4beb72), открыв файл воркспейса после перевода. Запуск:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON playground/scripts/pilot-legacy-rollback.mjs <путь к ai-cyborg на e4beb72> [--json]
// Берёт настоящий `ProjectStore` старого приложения (src/main/projects.ts, jira-keys.ts, jsonfile.ts копируются во временный каталог, импорты получают `.ts`),
// переводит копию фикстуры хуком приложения и просит старое приложение прочитать и записать её. ai-cyborg и файлы пользователя не трогаются.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openWorkspace } from '@cyborg-harness/core';
import { migrateLegacyWorkspace } from '../src/main/legacy-workspace.ts';

const [source] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (source === undefined) throw new Error('нужен путь к ai-cyborg на коммите e4beb72');
const head = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
if (!head.startsWith('e4beb72')) console.warn(`внимание: ai-cyborg на ${head || 'неизвестном коммите'}, а не на e4beb72`);

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cyborg-pl06-rollback-')));
try {
  const oldDir = path.join(root, 'old');
  mkdirSync(oldDir);
  for (const name of ['projects', 'jira-keys', 'jsonfile']) {
    const text = readFileSync(path.join(source, 'src', 'main', `${name}.ts`), 'utf8');
    writeFileSync(path.join(oldDir, `${name}.ts`), text.replace(/from '(\.\/[a-z-]+)'/g, "from '$1.ts'"));
  }
  const file = path.join(root, 'team.cyborg.json');
  cpSync(path.join(import.meta.dirname, '..', 'src', 'main', 'fixtures', 'workspace-e4beb72.cyborg.json'), file);
  const original = readFileSync(file);
  const opened = await openWorkspace({ file, userFile: path.join(root, 'user', 'cyborg.json'), stateDir: path.join(root, 'state'), migrate: migrateLegacyWorkspace });
  if (!opened.ok) throw new Error('воркспейс занят');
  opened.workspace.close();
  const migrated = readFileSync(file);

  // Старое приложение: `ProjectStore.load()`, затем сохранение проектов, как после создания проекта в окне (`saveProjectsState` -> `store.save`), затем `loadCommands()`.
  const probe = path.join(oldDir, 'probe.ts');
  writeFileSync(
    probe,
    `import { ProjectStore } from './projects.ts';
const store = new ProjectStore(process.argv[2]);
const loaded = store.load();
const problem = store.problem();
const commandsBefore = store.loadCommands();
let saved = null;
if (process.argv[3] === 'save') {
  store.save({ projects: [{ id: 'new', name: 'Новый', description: '', repos: ['/work/example/new'], trackers: { github: false, gitlab: false } }], lastProjectId: 'new' });
  saved = true;
}
console.log(JSON.stringify({ projects: loaded.projects.map((p) => p.id), lastProjectId: loaded.lastProjectId, problem, commandsBefore: commandsBefore === undefined ? 'нет' : commandsBefore.length, saved }));
`,
  );
  const old = (mode) => {
    const r = spawnSync(process.execPath, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', probe, file, mode], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').at(-1));
  };
  const names = () => readdirSync(root).filter((n) => !n.endsWith('.lock') && n !== 'old').sort();
  const report = { afterMigration: names(), oldReadsMigrated: old('load'), namesAfterRead: names() };
  report.copyEqualsMigrated = readdirSync(root).filter((n) => n.includes('.corrupt-')).map((n) => readFileSync(path.join(root, n)).equals(migrated));
  report.oldSaves = old('save');
  report.fileKeysAfterOldSave = Object.keys(JSON.parse(readFileSync(file, 'utf8')));
  report.backupIntact = readFileSync(`${file}.v1.bak`).equals(original);
  // Откат вручную: вернуть копию, старое приложение видит прежние данные целиком.
  cpSync(`${file}.v1.bak`, file);
  report.oldReadsRestored = old('load');
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}

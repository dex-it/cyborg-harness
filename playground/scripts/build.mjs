// Сборка playground в playground/dist: главный процесс, процесс хоста, preload, окно и демо-плагины.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDelivery } from '@cyborg-harness/core/delivery';
import { buildDelivery, buildPlugin } from 'cyborg-plugin';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'renderer', 'probe'), { recursive: true });
mkdirSync(join(dist, 'renderer', 'shell'), { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'warning' };
// import.meta в transports.ts нужен только хостам на node:child_process, а playground держит хосты в utilityProcess.
await build({ ...common, entryPoints: [join(src, 'main/main.ts')], outfile: join(dist, 'main.js'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'node-pty'], logOverride: { 'empty-import-meta': 'silent' } });
// ESM, а не cjs: в cjs esbuild заменил бы import(entry) плагина на require.
await build({ ...common, stdin: { contents: "import '@cyborg-harness/electron/host-entry';", resolveDir: root }, outfile: join(dist, 'plugin-host.mjs'), platform: 'node', format: 'esm', target: 'node22' });
// Вход хоста для процесса Node (`forkHosts`): хост стороннего плагина (TR-21, ADR-CH-0019) и спайк TR-20. Свой каталог: хосту под `--permission` разрешено читать только его (и каталог плагина).
await build({ ...common, stdin: { contents: "import '@cyborg-harness/core/host-entry';", resolveDir: root }, outfile: join(dist, 'node-host', 'host.mjs'), platform: 'node', format: 'esm', target: 'node22' });
// Процесс pty-хоста (K-01): cjs, как главный, - `node-pty` нативный и подгружается снаружи бандла.
await build({ ...common, stdin: { contents: "import '@cyborg-harness/electron/pty-host-entry';", resolveDir: root }, outfile: join(dist, 'pty-host.js'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'node-pty'] });
await build({ ...common, entryPoints: [join(src, 'main/preload.ts')], outfile: join(dist, 'preload.js'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
const browser = { ...common, platform: 'browser', format: 'iife', target: 'chrome130' };
for (const page of ['app', 'spike', 'probe/probe']) await build({ ...browser, entryPoints: [join(src, `renderer/${page}.ts`)], outfile: join(dist, `renderer/${page}.js`) });
for (const file of ['index.html', 'styles.css', 'spike.html', 'spike.css', 'probe/index.html', 'probe/probe.css']) cpSync(join(src, 'renderer', file), join(dist, 'renderer', file));
// Оболочку вида собирает пакет адаптера; приложение кладёт её рядом с окном и отдаёт видам через serveViews.
const shellDir = dirname(fileURLToPath(import.meta.resolve('@cyborg-harness/electron/shell/shell.js')));
for (const file of ['shell.js', 'shell.js.map', 'shell.css']) cpSync(join(shellDir, file), join(dist, 'renderer', 'shell', file));
// Плагины стенда собирает инструмент автора (P-06, tools/cyborg-plugin): главная часть остаётся исходниками (`main: 'source'`, стенд проверяет загрузку .ts),
// модуль вида из ui/*.ts собирается в ESM, потому что его грузит браузер через import(). Общие файлы каталога плагинов (contracts.ts, package.json) копируются как есть.
const plugins = join(root, 'plugins');
mkdirSync(join(dist, 'plugins'), { recursive: true });
for (const entry of readdirSync(plugins, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    cpSync(join(plugins, entry.name), join(dist, 'plugins', entry.name));
    continue;
  }
  const report = await buildPlugin(join(plugins, entry.name), { out: join(dist, 'plugins', entry.name), main: 'source', check: false });
  for (const warning of report.warnings) console.warn(`${entry.name}: ${warning}`);
  if (!report.ok) throw new Error(`плагин ${entry.name}: ${report.problems.map((p) => `${p.file}${p.line === undefined ? '' : `:${String(p.line)}`}: ${p.message}`).join('; ')}`);
}
cpSync(join(root, 'bench'), join(dist, 'bench'), { recursive: true });
// Плагины пробы доверия (TR-01): нарушитель, поставщик и потребитель; `--trust-probe` грузит их исходниками, как bench.
cpSync(join(root, 'trust-probe'), join(dist, 'trust-probe'), { recursive: true });
// Воркеры Monaco - файлы того же origin, а не blob: (PL-05): каждый - отдельный классический скрипт, у воркера нет общего модуля с видом.
const monaco = join(root, '..', 'node_modules', 'monaco-editor', 'esm', 'vs');
const workers = { editor: 'editor/editor.worker.js', json: 'language/json/json.worker.js', css: 'language/css/css.worker.js', html: 'language/html/html.worker.js', ts: 'language/typescript/ts.worker.js' };
for (const [name, entry] of Object.entries(workers)) await build({ ...browser, entryPoints: [join(monaco, entry)], outfile: join(dist, 'plugins', 'editor', 'ui', 'workers', `${name}.worker.js`) });
// Вид грузит стили только со своего origin: таблица xterm кладётся рядом с модулем вида sessions.
cpSync(join(root, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), join(dist, 'plugins', 'sessions', 'ui', 'xterm.css'));
// P-07: те же плагины в виде поставки приложения - `dist/delivery`: собраны в index.mjs, рядом delivery.json с хешами. Её грузит запуск с `--delivery` и упакованная проба
// (pack-delivery.mjs). Файлы, которые стенд кладёт рядом с видами выше (таблица xterm, воркеры Monaco), в поставке нужны тем же видам; хеши считаются после их копирования.
const delivery = join(dist, 'delivery');
// Пилоты PL-04 (files, git, viewer), PL-06 (legacy-prefs), PL-07 (trackers), PL-10 (trackers-http) и PL-03 (keys-pilot) - плагины для тестов ядра: не включены в DEFAULT_CONFIG, окна не имеют, и проверка упакованной поставки ждёт, что каждый плагин поставки активен.
const PILOT_ONLY = new Set(['files', 'git', 'viewer', 'legacy-prefs', 'trackers', 'trackers-http', 'keys-pilot']);
const built = await buildDelivery(readdirSync(plugins, { withFileTypes: true }).filter((e) => e.isDirectory() && !PILOT_ONLY.has(e.name)).map((e) => join(plugins, e.name)), { out: delivery, declarations: [join(plugins, 'contracts.ts')] });
for (const warning of built.warnings) console.warn(`delivery: ${warning}`);
if (!built.ok) throw new Error(`поставка стенда: ${built.problems.map((p) => `${p.file}${p.line === undefined ? '' : `:${String(p.line)}`}: ${p.message}`).join('; ')}`);
cpSync(join(dist, 'plugins', 'sessions', 'ui', 'xterm.css'), join(delivery, 'sessions', 'ui', 'xterm.css'));
cpSync(join(dist, 'plugins', 'editor', 'ui', 'workers'), join(delivery, 'editor', 'ui', 'workers'), { recursive: true });
await writeDelivery(delivery);

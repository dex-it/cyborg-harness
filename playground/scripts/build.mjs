// Сборка playground в playground/dist: главный процесс, процесс хоста, preload, окно и демо-плагины.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
await build({ ...common, entryPoints: [join(src, 'main/preload.ts')], outfile: join(dist, 'preload.js'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
const browser = { ...common, platform: 'browser', format: 'iife', target: 'chrome130' };
for (const page of ['app', 'spike', 'probe/probe']) await build({ ...browser, entryPoints: [join(src, `renderer/${page}.ts`)], outfile: join(dist, `renderer/${page}.js`) });
for (const file of ['index.html', 'styles.css', 'spike.html', 'spike.css', 'probe/index.html', 'probe/probe.css', 'shell/shell.css']) cpSync(join(src, 'renderer', file), join(dist, 'renderer', file));
await build({ ...browser, entryPoints: [join(src, 'renderer/shell/shell.ts')], outfile: join(dist, 'renderer/shell/shell.js') });
// Модуль вида грузит браузер через import(): его TypeScript собирается в ESM, а код главной части хост грузит как есть.
const views = readdirSync(join(root, 'plugins'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, 'plugins', d.name, 'ui')))
  .flatMap((d) => readdirSync(join(root, 'plugins', d.name, 'ui')).filter((f) => f.endsWith('.ts')).map((f) => join(d.name, 'ui', f)));
cpSync(join(root, 'plugins'), join(dist, 'plugins'), { recursive: true, filter: (from) => !/[/\\]ui[/\\][^/\\]+\.ts$/.test(from) });
cpSync(join(root, 'bench'), join(dist, 'bench'), { recursive: true });
for (const file of views) await build({ ...browser, format: 'esm', entryPoints: [join(root, 'plugins', file)], outfile: join(dist, 'plugins', file.replace(/\.ts$/, '.js')) });
// Вид грузит стили только со своего origin: таблица xterm кладётся рядом с модулем вида sessions.
cpSync(join(root, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), join(dist, 'plugins', 'sessions', 'ui', 'xterm.css'));

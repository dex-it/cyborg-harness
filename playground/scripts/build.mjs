// Сборка playground в playground/dist: главный процесс, процесс хоста, preload, окно и демо-плагины.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'renderer'), { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'warning' };
// import.meta в transports.ts нужен только хостам на node:child_process, а playground держит хосты в utilityProcess.
await build({ ...common, entryPoints: [join(src, 'main/main.ts')], outfile: join(dist, 'main.js'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logOverride: { 'empty-import-meta': 'silent' } });
// ESM, а не cjs: в cjs esbuild заменил бы import(entry) плагина на require.
await build({ ...common, entryPoints: [join(src, 'main/plugin-host.ts')], outfile: join(dist, 'plugin-host.mjs'), platform: 'node', format: 'esm', target: 'node22' });
await build({ ...common, entryPoints: [join(src, 'main/preload.ts')], outfile: join(dist, 'preload.js'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
await build({ ...common, entryPoints: [join(src, 'renderer/app.ts')], outfile: join(dist, 'renderer/app.js'), platform: 'browser', format: 'iife', target: 'chrome130' });
for (const file of ['index.html', 'styles.css']) cpSync(join(src, 'renderer', file), join(dist, 'renderer', file));
cpSync(join(root, 'plugins'), join(dist, 'plugins'), { recursive: true });

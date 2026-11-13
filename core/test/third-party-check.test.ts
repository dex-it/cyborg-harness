// TR-06 (ADR-CH-0003, «Расхождения», п. 6): загрузчик зовёт проверку импортов для плагина вне поставки; найденное - предупреждение в журнале строк, загрузка идёт.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { load } from '../src/loader.ts';
import type { PluginModule } from '../src/plugin.ts';
import { inlineHosts } from '../src/transports.ts';

const manifest = (id: string) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, commands: [`${id}.ping`] });

async function plugin(root: string, id: string, source: string, withManifest = true): Promise<string> {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  if (withManifest) await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest(id)));
  const entry = path.join(dir, 'index.ts');
  await writeFile(entry, source);
  return pathToFileURL(entry).href;
}

const CLEAN = `export default { activate(ctx) { ctx.commands.register('NAME.ping', () => 'pong'); } };\n`;
const DIRTY = `import fs from 'node:fs';\nimport cp from 'node:child_process';\nexport default { activate(ctx) { ctx.commands.register('NAME.ping', () => typeof fs + typeof cp); } };\n`;

async function start(root: string, entries: Record<string, string>, bundled: string[] | undefined) {
  const lines: string[] = [];
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async (entry) => ((await import(entry)) as { default: PluginModule }).default),
    enabled: Object.keys(entries),
    manifests: Object.keys(entries).map(manifest),
    ...(bundled !== undefined && { bundled }),
    entry: (m) => entries[m.id] ?? m.id,
    onLog: (id, message, level) => lines.push(`${id} [${level}] ${message}`),
  });
  return { k, lines };
}

test('ST-3001/9: плагин вне поставки с node:fs и child_process в главной части - предупреждения в журнале строк, плагин активирован и работает', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-audit-')));
  try {
    const entries = { dirty: await plugin(root, 'dirty', DIRTY.replaceAll('NAME', 'dirty')) };
    const { k, lines } = await start(root, entries, ['somebody-else']);
    const warnings = lines.filter((l) => l.startsWith('dirty [warn]') && l.includes('проверка импортов'));
    assert.equal(warnings.length, 2, lines.join('\n'));
    assert.ok(warnings.some((l) => l.includes('node:fs')) && warnings.some((l) => l.includes('node:child_process')), warnings.join('\n'));
    assert.ok(k.active.includes('dirty'), 'плагин не блокируется');
    assert.equal(await k.run('dirty.ping'), 'objectobject');
    // Один раз за запуск ядра: повторная активация (disable, enable) предупреждений не множит.
    await k.disable('dirty');
    await k.enable('dirty');
    assert.equal(lines.filter((l) => l.includes('проверка импортов')).length, 2);
    await k.unload();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ST-3001/9: плагин из поставки с теми же импортами не проверяется, чистый сторонний молчит, без bundled проверки нет', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-audit-')));
  try {
    const entries = {
      shipped: await plugin(root, 'shipped', DIRTY.replaceAll('NAME', 'shipped')),
      clean: await plugin(root, 'clean', CLEAN.replaceAll('NAME', 'clean')),
    };
    const a = await start(root, entries, ['shipped']);
    assert.deepEqual(a.lines.filter((l) => l.includes('проверка импортов')), [], a.lines.join('\n'));
    assert.deepEqual([...a.k.active].sort(), ['clean', 'shipped']);
    await a.k.unload();
    const b = await start(root, entries, undefined);
    assert.deepEqual(b.lines.filter((l) => l.includes('проверка импортов')), [], 'поставку не от чего отличить: проверки нет');
    await b.k.unload();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ST-3001/9: нет manifest.json рядом с точкой входа - проверять нечего, плагин загружается', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-audit-')));
  try {
    const bare = await plugin(root, 'bare', DIRTY.replaceAll('NAME', 'bare'), false);
    const { k, lines } = await start(root, { bare }, ['somebody-else']);
    assert.deepEqual(lines.filter((l) => l.includes('проверка импортов')), [], lines.join('\n'));
    assert.ok(k.active.includes('bare'));
    await k.unload();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ST-3001/9: много нарушений - десять строк и одна «и ещё N», остальное в cyborg-plugin check', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-audit-')));
  try {
    const imports = Array.from({ length: 14 }, (_, i) => `import m${String(i)} from 'node:fs';\nvoid m${String(i)};`).join('\n');
    const many = await plugin(root, 'many', `${imports}\nexport default { activate(ctx) { ctx.commands.register('many.ping', () => 1); } };\n`);
    const { k, lines } = await start(root, { many }, ['somebody-else']);
    const audit = lines.filter((l) => l.includes('проверка импортов'));
    assert.equal(audit.length, 11, audit.join('\n'));
    assert.match(audit[10] ?? '', /и ещё 4 замечаний/);
    assert.ok(k.active.includes('many'));
    await k.unload();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

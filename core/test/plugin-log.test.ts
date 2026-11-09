import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PluginContext } from '@cyborg-harness/contracts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { load, type JournalEntry, type Kernel, type LoadOptions } from '../src/loader.ts';
import { inlineHosts } from '../src/transports.ts';

// K-29 (FR-CH-4009, 4010, 4018): уровень строки ctx.log, вывод хоста по плагину, предел длины и частоты, вычёркивание секретов.

type Line = readonly [pluginId: string, message: string, level: string];

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });

interface Rig {
  readonly k: Kernel;
  /** Контексты плагинов: тест пишет в `ctx.log` от их имени. */
  readonly ctx: Record<string, PluginContext>;
  readonly lines: Line[];
  readonly journal: JournalEntry[];
}

/** Ядро с хостами в процессе теста: плагин берёт свой `ctx` при активации, строки собираются из `onLog`. */
async function rig(ids: readonly string[], options: Partial<LoadOptions> = {}): Promise<Rig> {
  const ctx: Record<string, PluginContext> = {};
  const lines: Line[] = [];
  const journal: JournalEntry[] = [];
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ids,
    manifests: ids.map((id) => manifest(id)),
    spawnHost: inlineHosts(async (entry) => ({ activate: (c: PluginContext) => void (ctx[entry] = c) })),
    onLog: (pluginId, message, level) => void lines.push([pluginId, message, level]),
    onJournal: (e) => void journal.push(e),
    ...options,
  });
  return { k, ctx, lines, journal };
}

/** Ждёт, пока условие станет истинным: хост доставляет сообщения через очередь, а не синхронно. */
async function until(what: string, ok: () => boolean, ms = 3000): Promise<void> {
  for (const end = Date.now() + ms; !ok(); await sleep(5)) if (Date.now() > end) throw new Error(`не дождались: ${what}`);
}

test('ctx.log: без уровня - info, с уровнем - он; в записи id плагина', async () => {
  const { k, ctx, lines } = await rig(['a', 'b']);
  try {
    ctx.a?.log('x');
    ctx.a?.log('y', 'error');
    ctx.b?.log('z', 'warn');
    await until('три строки', () => lines.length === 3);
    assert.deepEqual(lines, [['a', 'x', 'info'], ['a', 'y', 'error'], ['b', 'z', 'warn']]);
  } finally {
    await k.unload();
  }
});

test('ctx.log: неизвестный уровень - Invalid в плагине, строка не пишется', async () => {
  const { k, ctx, lines } = await rig(['a']);
  try {
    assert.throws(() => ctx.a?.log('x', 'debug' as never), { code: 'Invalid' });
    ctx.a?.log('после');
    await until('строка после отказа', () => lines.length === 1);
    assert.deepEqual(lines, [['a', 'после', 'info']]);
  } finally {
    await k.unload();
  }
});

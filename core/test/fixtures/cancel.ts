// Стенд отмены: поставщик `provider` держит вызов, пока его не отпустят или не отменят, потребитель `user` зовёт его с сигналом.
import { setTimeout as sleep } from 'node:timers/promises';
import { PLUGIN_API_VERSION } from '../../src/api-version.ts';
import { load, type LoadOptions } from '../../src/loader.ts';
import type { PluginContext, PluginModule } from '../../src/plugin.ts';
import { inlineHosts } from '../../src/transports.ts';

export const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });

const codeOf = (reason: unknown): string => (typeof reason === 'object' && reason !== null && 'code' in reason ? String(reason.code) : '?');

export async function startCancel(extra: Partial<LoadOptions> = {}) {
  /** Что видел поставщик: `метка:start`, `метка:abort:<код>`, `метка:done`. */
  const log: string[] = [];
  const held = { slowMs: 5_000, watchMs: 40 };
  const listeners = new Set<(n: number) => void>();
  let ctx: PluginContext | undefined;
  const table: Record<string, PluginModule> = {
    provider: {
      activate(c) {
        c.contracts.provide('test.cancel', '1.0', {
          slow(label, signal) {
            log.push(`${label}:start`);
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                log.push(`${label}:done`);
                resolve(label);
              }, held.slowMs);
              timer.unref();
              signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                log.push(`${label}:abort:${codeOf(signal.reason)}`);
                reject(signal.reason as Error);
              });
            });
          },
          async watch(listener, signal) {
            await sleep(held.watchMs);
            log.push(`watch:${signal?.aborted ? 'aborted' : 'ok'}`);
            listeners.add(listener);
            return { dispose: () => void listeners.delete(listener) };
          },
          listeners: () => listeners.size,
        });
        c.commands.register('provider.slow', (label: unknown, signal: unknown) => {
          log.push(`cmd:${String(label)}:${signal instanceof AbortSignal ? 'signal' : 'no-signal'}`);
          return new Promise((_, reject) => {
            if (signal instanceof AbortSignal) {
              signal.addEventListener('abort', () => {
                log.push(`cmd:abort:${codeOf(signal.reason)}`);
                reject(signal.reason as Error);
              });
            }
          });
        });
        return undefined;
      },
    },
    user: {
      activate(c) {
        ctx = c;
        return undefined;
      },
    },
  };
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['provider', 'user'],
    manifests: [
      manifest('provider', { provides: { 'test.cancel': '1.0' }, commands: { 'provider.slow': { args: ['string'] } } }),
      manifest('user', { requires: { 'test.cancel': '^1' } }),
    ],
    hosts: { p: ['provider'], u: ['user'] },
    spawnHost: inlineHosts(async (entry) => {
      const mod = table[entry];
      if (!mod) throw new Error(`нет модуля ${entry}`);
      return mod;
    }),
    ...extra,
  });
  const api = ctx!.contracts.get('test.cancel', 1)!;
  return { kernel, api, ctx: ctx!, log, held, listeners };
}

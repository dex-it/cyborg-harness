import fs from 'node:fs';
import path from 'node:path';
import type { PluginModule } from '@cyborg/contracts';

/** Поставщик замера: отвечает на вызовы и занимает поток хоста синхронной работой, как это делает настоящий плагин. */
const provider: PluginModule = {
  activate(ctx) {
    const listeners = new Set<(data: string) => void>();
    ctx.contracts.provide('bench.rpc', '1.0', {
      echo: async (data) => data,
      async burst(count, data) {
        for (let i = 0; i < count; i++) for (const listener of listeners) listener(data);
      },
      onData(listener) {
        listeners.add(listener);
        return { dispose: () => void listeners.delete(listener) };
      },
    });
    ctx.commands.register('bench-provider.echo', (data) => data);
    ctx.commands.register('bench-provider.block', (ms) => {
      const start = performance.now();
      while (performance.now() - start < Number(ms));
      return performance.now() - start;
    });
    ctx.commands.register('bench-provider.parse', (mb) => {
      const text = JSON.stringify(Array.from({ length: Math.round((Number(mb) * 1e6) / 64) }, (_, i) => ({ id: i, name: `item-${i}`, ok: true })));
      const start = performance.now();
      JSON.parse(text);
      return { ms: performance.now() - start, mb: text.length / 1e6 };
    });
    ctx.commands.register('bench-provider.scan', (dir) => {
      const start = performance.now();
      const entries = fs.readdirSync(path.resolve(String(dir)), { recursive: true });
      return { ms: performance.now() - start, entries: entries.length };
    });
    return undefined;
  },
};

export default provider;

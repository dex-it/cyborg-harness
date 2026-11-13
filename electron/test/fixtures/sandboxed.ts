import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { PluginModule } from '@cyborg-harness/core';

/** Плагин-нарушитель хоста под запретами (TR-21): что ему разрешено в процессе и что он вернёт ядру. */
const attempt = (action: () => unknown): string => {
  try {
    action();
    return 'выполнено';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? (error as Error).name;
  }
};

const plugin: PluginModule = {
  activate(ctx) {
    ctx.commands.register('sandboxed.probe', (outside) => ({
      pid: process.pid,
      permission: typeof (process as { permission?: unknown }).permission,
      env: Object.keys(process.env).sort(),
      readOutside: attempt(() => fs.readFileSync(String(outside))),
      spawn: attempt(() => spawnSync('/bin/echo', ['x'])),
    }));
    ctx.commands.register('sandboxed.echo', (value) => value);
    ctx.commands.register('sandboxed.bytes', (value) => ({ length: (value as Uint8Array).length }));
    ctx.commands.register('sandboxed.leak', () => ({ cb: () => 0 }));
    ctx.commands.register('sandboxed.hang', () => {
      for (;;);
    });
    ctx.commands.register('sandboxed.crash', () => process.exit(3));
  },
};
export default plugin;

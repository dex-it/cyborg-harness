import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { PluginModule } from '../../src/plugin.ts';

/** Плагин-нарушитель хоста под `--permission`: что ему разрешено в процессе и что он вернёт ядру через границу (TR-20). */
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
      execArgv: process.execArgv,
      readOutside: attempt(() => fs.readFileSync(String(outside))),
      spawn: attempt(() => spawnSync('/bin/echo', ['x'])),
      versions: process.versions.node,
      electron: process.versions.electron ?? null,
    }));
    ctx.commands.register('sandboxed.echo', (value) => value);
    ctx.commands.register('sandboxed.bytes', (value) => ({ isU8: value instanceof Uint8Array, length: (value as Uint8Array).length, sum: (value as Uint8Array).reduce((a, b) => a + b, 0) }));
    ctx.commands.register('sandboxed.leak', () => ({ cb: () => 0 }));
    ctx.commands.register('sandboxed.hang', () => {
      for (;;);
    });
    ctx.commands.register('sandboxed.crash', () => process.exit(3));
  },
};
export default plugin;

import type { PluginModule } from '@cyborg-harness/contracts';
import { percentiles } from './contracts.ts';

/** Замер цены вызова `ctx.os` из хоста (спайк TR-20): `fs.readText` файла заданного размера, п. 1 мс на p99 до 64 КиБ (NFR-CH-1001). Прямого `node:fs` здесь нет: под --permission он закрыт. */
const osRead: PluginModule = {
  activate(ctx) {
    ctx.commands.register('bench-osread.run', async (file, count) => {
      for (let i = 0; i < 30; i++) await ctx.os.fs.readText(String(file));
      const times: number[] = [];
      const start = performance.now();
      for (let i = 0; i < Number(count); i++) {
        const t = performance.now();
        await ctx.os.fs.readText(String(file));
        times.push(performance.now() - t);
      }
      return percentiles(times, performance.now() - start);
    });
    return undefined;
  },
};

export default osRead;

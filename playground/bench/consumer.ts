import type { PluginModule } from '@cyborg-harness/contracts';
import { percentiles } from './contracts.ts';

/** Потребитель замера: меряет вызовы контракта и поток событий изнутри своего хоста. */
const consumer: PluginModule = {
  async activate(ctx) {
    const rpc = ctx.contracts.get('bench.rpc', 1);
    if (!rpc) throw new Error('bench.rpc в requires, но его нет');
    let wanted = 0;
    let got = 0;
    let done: (() => void) | undefined;
    await rpc.onData(() => {
      got++;
      if (got === wanted) done?.();
    });

    ctx.commands.register('bench-consumer.calls', async (count, size) => {
      const data = 'x'.repeat(Number(size));
      for (let i = 0; i < 30; i++) await rpc.echo(data);
      const times: number[] = [];
      const start = performance.now();
      for (let i = 0; i < Number(count); i++) {
        const t = performance.now();
        await rpc.echo(data);
        times.push(performance.now() - t);
      }
      return percentiles(times, performance.now() - start);
    });
    ctx.commands.register('bench-consumer.stream', async (count, size) => {
      got = 0;
      wanted = Number(count);
      const arrived = new Promise<void>((resolve) => (done = resolve));
      const start = performance.now();
      await rpc.burst(wanted, 'x'.repeat(Number(size)));
      await arrived;
      return performance.now() - start;
    });
    return undefined;
  },
};

export default consumer;

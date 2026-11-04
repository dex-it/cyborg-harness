import type { PluginModule } from '../../../src/index.ts';

type Clock = Record<string, (...args: unknown[]) => Promise<unknown>>;

const plugin: PluginModule = {
  activate(ctx) {
    const clock = ctx.contracts.get<Clock>('demo.clock')!;
    ctx.commands.register('clock-user.probe', async () => {
      const out: string[] = [];
      const attempt = async (label: string, call: () => Promise<unknown>) => {
        try {
          out.push(`${label}: ок ${JSON.stringify(await call())}`);
        } catch (error) {
          out.push(`${label}: ${(error as { code?: string }).code ?? 'ошибка'} - ${(error as Error).message}`);
        }
      };
      await attempt('now()', () => clock.now());
      await attempt('nowSync()', () => clock.nowSync());
      await attempt('onTick(fn)', () => clock.onTick(() => 0));
      return out;
    });
  },
};

export default plugin;

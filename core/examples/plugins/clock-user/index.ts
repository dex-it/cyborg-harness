import { CoreError, errorMessage, type PluginModule } from '../../../src/index.ts';

const plugin: PluginModule = {
  activate(ctx) {
    const clock = ctx.contracts.get('demo.clock', 1);
    if (!clock) throw new Error('demo.clock в requires, но его нет');
    ctx.commands.register('clock-user.probe', async () => {
      const out: string[] = [];
      const attempt = async (label: string, call: () => Promise<unknown>) => {
        try {
          out.push(`${label}: ок ${JSON.stringify(await call())}`);
        } catch (error) {
          out.push(`${label}: ${error instanceof CoreError ? error.code : 'ошибка'} - ${errorMessage(error)}`);
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

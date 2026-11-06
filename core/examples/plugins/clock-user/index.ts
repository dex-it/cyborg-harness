import type { PluginModule } from '@cyborg-harness/contracts';

/** Отказ ядра приходит как Error с полем code; класс CoreError плагину не виден. */
const codeOf = (error: unknown): string => (error instanceof Error && 'code' in error ? String(error.code) : 'ошибка');

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
          out.push(`${label}: ${codeOf(error)} - ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      await attempt('now()', () => clock.now());
      await attempt('nowSync()', () => clock.nowSync());
      await attempt('onTick(fn)', async () => {
        const ticks: number[] = [];
        const sub = await clock.onTick((tick) => ticks.push(tick));
        await new Promise((r) => setTimeout(r, 40));
        sub.dispose();
        return ticks.length > 0 ? 'тики пришли, подписка снята' : 'тиков нет';
      });
      return out;
    });
  },
};

export default plugin;

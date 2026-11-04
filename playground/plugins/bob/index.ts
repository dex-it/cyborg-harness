import type { Disposable, PluginModule } from '../../../core/src/index.ts';

// Чат и эхо в optional: bob переживает их выгрузку и переподписывается, когда чат возвращается.
const bob: PluginModule = {
  activate(ctx) {
    const chat = () => ctx.contracts.get('demo.chat', 1);
    let subscription: Disposable | undefined;

    const join = async () => {
      subscription?.dispose();
      subscription = undefined;
      const current = chat();
      if (!current) return;
      subscription = await current.onMessage((m) => {
        if (m.from === 'bob') return;
        ctx.log(`← ${m.from}: ${m.text}`);
        void reply(m.text);
      });
    };
    const reply = async (text: string) => {
      const echo = ctx.contracts.get('demo.echo', 1);
      const answer = echo ? await echo.say(text) : `${text} (эха нет)`;
      await chat()?.send('bob', `ответ: ${answer}`);
      ctx.log(`→ ответ: ${answer}`);
    };

    ctx.contracts.onChange('demo.chat', () => {
      ctx.log(chat() ? 'чат вернулся, подписываюсь снова' : 'чат пропал');
      void join();
    });
    ctx.commands.register('bob.hello', async () => {
      const current = chat();
      if (!current) {
        ctx.log('чата нет, сказать некому');
        return;
      }
      await current.send('bob', 'привет, alice');
      ctx.log('→ привет, alice');
    });
    ctx.commands.register('bob.status', () =>
      ctx.log(`чат ${chat() ? 'есть' : 'нет'}, эхо ${ctx.contracts.get('demo.echo', 1) ? 'есть' : 'нет'}, процесс ${process.pid}`),
    );
    void join();
    return { dispose: () => subscription?.dispose() };
  },
};

export default bob;

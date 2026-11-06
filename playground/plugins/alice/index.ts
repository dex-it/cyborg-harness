import type { PluginModule } from '@cyborg-harness/contracts';

// Чат в requires: без него alice не запускается, а выгрузка чата снимает и её.
const alice: PluginModule = {
  async activate(ctx) {
    const chat = ctx.contracts.get('demo.chat', 1);
    if (!chat) throw new Error('demo.chat в requires, но его нет');
    await chat.onMessage((m) => {
      if (m.from !== 'alice') ctx.log(`← ${m.from}: ${m.text}`);
    });
    ctx.commands.register('alice.hello', async () => {
      await chat.send('alice', 'привет, bob');
      ctx.log('→ привет, bob');
    });
    return undefined;
  },
};

export default alice;

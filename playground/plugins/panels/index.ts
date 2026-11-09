import type { PluginModule } from '@cyborg-harness/contracts';

// Два вида одного плагина в разных областях. Главная часть показывает канал «главная часть - вид» (K-13): толчок идёт только виду panel,
// а виду bar (то же имя плагина, другое имя вида) не доходит.
const panels: PluginModule = {
  activate(ctx) {
    const channel = ctx.views.channel('panel');
    let pings = 0;
    ctx.commands.register('panels.ping', () => channel.post({ ping: ++pings }));
    channel.onMessage((message) => ctx.log(`вид panel сообщил: ${JSON.stringify(message)}`));
    return undefined;
  },
};

export default panels;

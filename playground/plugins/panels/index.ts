import type { PluginModule } from '@cyborg-harness/contracts';

// Два вида одного плагина в разных областях. Главная часть показывает канал «главная часть - вид» (K-13): толчок идёт только виду panel,
// а виду bar (то же имя плагина, другое имя вида) не доходит. Модальное окно (вид form с area "modal") и диалог из главной части: команды panels.form, panels.form-own (размер и Escape от автора), panels.form-fit (высота по просьбе вида) и panels.confirm.
const panels: PluginModule = {
  activate(ctx) {
    const channel = ctx.views.channel('panel');
    let pings = 0;
    ctx.commands.register('panels.ping', () => channel.post({ ping: ++pings }));
    channel.onMessage((message) => ctx.log(`вид panel сообщил: ${JSON.stringify(message)}`));
    ctx.commands.register('panels.form', async () => {
      const result = await ctx.views.modal('form', { data: { name: 'черновик' } });
      ctx.log(`форма вернула: ${result === undefined ? 'ничего' : JSON.stringify(result)}`);
      return result;
    });
    // Окно с размером автора и Escape у вида (#163): вид сам решает, что значит Escape, и закрывает окно кнопкой.
    ctx.commands.register('panels.form-own', async () => {
      const result = await ctx.views.modal('form', { title: 'Широкая форма', data: { name: 'черновик', ownEscape: true }, size: { width: 700, height: 300 }, escape: 'view' });
      ctx.log(`широкая форма вернула: ${result === undefined ? 'ничего' : JSON.stringify(result)}`);
      return result;
    });
    // Окно «по содержимому» (#197): высоту просит сам вид через ctx.modal.resize.
    ctx.commands.register('panels.form-fit', async () => {
      const result = await ctx.views.modal('form', { title: 'Окно по содержимому', data: { name: 'черновик', fit: true } });
      ctx.log(`форма по содержимому вернула: ${result === undefined ? 'ничего' : JSON.stringify(result)}`);
      return result;
    });
    ctx.commands.register('panels.confirm', async () => {
      const choice = await ctx.dialogs.show({ kind: 'ask', title: 'Удалить проект?', message: 'Без возврата', buttons: [{ id: 'yes', label: 'Да' }, { id: 'no', label: 'Нет' }] });
      ctx.log(`диалог главной части ответил: ${choice ?? 'ничего'}`);
      return choice;
    });
    return undefined;
  },
};

export default panels;

import type { Disposable, PluginModule, SessionEvent } from '@cyborg-harness/contracts';

export const OPEN_COMMAND = 'session-notifications.open';

// Пилот PL-02: решение «показывать ли» живёт здесь, а не в ядре. Событие «ждёт» при окне без фокуса - одно уведомление;
// новая работа сессии или её выход снимают его (unnotify); клик поднимает окно (ядро) и запускает команду плагина.
const plugin: PluginModule = {
  activate(ctx) {
    // Права notify нет в манифесте или ядро её не выдало: ctx.os.notify тогда нет совсем, и плагин честно говорит, что показывать нечем.
    if (!ctx.os.notify) ctx.log('нет права notify: уведомления не показываются', 'warn');
    // onFocusChange сообщает только перемены, начального состояния нет: до первой перемены окно считается активным (иначе запуск был бы шумным).
    let focused = true;
    ctx.window.onFocusChange((now) => {
      focused = now;
    });
    // id уведомления ядра по сессии; уведомление у сессии одно, новое событие «ждёт» заменяет прежнее.
    const live = new Map<string, string>();
    // События одной очередью: «ждёт» и сразу за ним «работает» не должны разминуться на асинхронном show.
    let queue: Promise<void> = Promise.resolve();

    const unnotify = async (sessionId: string) => {
      const id = live.get(sessionId);
      if (id === undefined) return;
      live.delete(sessionId);
      await ctx.os.notify?.close(id);
    };
    const handle = async (event: SessionEvent) => {
      const { change } = event;
      switch (change.type) {
        case 'waiting': {
          if (focused) {
            ctx.log(`${event.title}: окно в фокусе, уведомление не нужно`);
            return;
          }
          const notify = ctx.os.notify;
          if (!notify) {
            ctx.log(`${event.title}: ждёт, но показывать нечем`);
            return;
          }
          await unnotify(event.sessionId);
          live.set(event.sessionId, await notify.show(event.title, change.reason, { onClick: { command: OPEN_COMMAND, args: [event.sessionId] } }));
          return;
        }
        case 'activity':
        case 'exit':
          await unnotify(event.sessionId);
          return;
        case 'cwd':
          return;
      }
    };
    const onEvent = (event: SessionEvent) => {
      queue = queue.then(() => handle(event)).catch((e: unknown) => ctx.log(`${event.title}: уведомление не показано - ${String(e)}`, 'warn'));
    };

    let subscription: Disposable | undefined;
    const join = async () => {
      subscription?.dispose();
      subscription = undefined;
      const sessions = ctx.contracts.get('cyborg.sessions', 1);
      if (!sessions) return;
      subscription = await sessions.onChange(onEvent);
      ctx.log('подписан на cyborg.sessions');
    };
    // Поставщик sessions может уйти и вернуться (перезапуск хоста): подписка тогда снята ядром, берём заново.
    const rejoin = () => void join().catch((e: unknown) => ctx.log(`подписка на cyborg.sessions: ${String(e)}`, 'warn'));
    ctx.contracts.onChange('cyborg.sessions', rejoin);
    rejoin();
    ctx.commands.register(OPEN_COMMAND, (sessionId) => {
      // Ядро закрыло уведомление клика само.
      if (typeof sessionId === 'string') live.delete(sessionId);
      ctx.log(`открыта сессия ${String(sessionId)}`);
    });
    return { dispose: () => subscription?.dispose() };
  },
};

export default plugin;

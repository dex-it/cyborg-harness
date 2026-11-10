import type { PluginModule } from '../../src/plugin.ts';

const hang = (): void => {
  for (;;);
};

/** Один раз на следующее событие окна/ОС от ядра (`note system`) - слушателем самого процесса, а не плагина. */
const onSystem = (fn: () => void): void => {
  const listener = (message: unknown): void => {
    if (typeof message !== 'object' || message === null || (message as { t?: unknown }).t !== 'note' || (message as { m?: unknown }).m !== 'system') return;
    process.off('message', listener);
    fn();
  };
  process.on('message', listener);
};

const plugin: PluginModule = {
  activate(ctx) {
    let onFocus: 'hang' | 'reject' | undefined;
    ctx.window.onFocusChange(() => {
      if (onFocus === 'hang') hang();
      if (onFocus === 'reject') void Promise.reject(new Error('busy: слушатель'));
    });
    ctx.commands.register('busy.timer', () => void setTimeout(hang, 0));
    ctx.commands.register('busy.late', () => void setTimeout(hang, 200));
    ctx.commands.register('busy.exit', () => void setTimeout(() => process.exit(3), 0));
    ctx.commands.register('busy.focus', () => void (onFocus = 'hang'));
    ctx.commands.register('busy.reject.timer', () => void setTimeout(() => void Promise.reject(new Error('busy: таймер')), 0));
    ctx.commands.register('busy.reject.focus', () => void (onFocus = 'reject'));
    // Отклонение приходит позже, чем хост успевает выполнить код соседа.
    ctx.commands.register('busy.reject.await', (ms) => {
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, Number(ms)));
        throw new Error('busy: после await');
      })();
    });
    // Бросок после ответа ядру: вызова в полёте нет, и виновника называет только отметка хоста.
    ctx.commands.register('busy.throw.microtask', () => void setTimeout(() => queueMicrotask(() => {
      throw new Error('busy: микрозадача');
    }), 0));
    ctx.commands.register('busy.throw.tick', () => void setTimeout(() => process.nextTick(() => {
      throw new Error('busy: nextTick');
    }), 0));
    // Слушатель процесса зовёт сам хост, вне цепочки плагина: так выглядит сбой кода хоста.
    // Ловушку снимает только событие окна `system`, которое тест шлёт после ответа на команду: пинг сторожа мог бы обогнать ответ и уронить хост раньше него,
    // тогда вызов в полёте назвал бы виновником плагина (раньше ловушкой был любой следующий `message`).
    ctx.commands.register('busy.host.throw', () => onSystem(() => {
      throw new Error('хост: исключение');
    }));
    ctx.commands.register('busy.host.reject', () => onSystem(() => void Promise.reject(new Error('хост: отклонение'))));
    ctx.commands.register('busy.host.timer', () => onSystem(() => void setTimeout(() => {
      throw new Error('хост: таймер');
    }, 0)));
    // Ответ чужой команды приходит после того, как хост успел выполнить код соседа.
    ctx.commands.register('busy.after', () => void ctx.commands.run('calm.echo', 1).then(hang));
  },
};
export default plugin;

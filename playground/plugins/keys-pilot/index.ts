import type { PluginModule } from '@cyborg-harness/contracts';

// Пилот PL-03: сочетания кнопок Cyborg (`command-buttons`) через `ctx.keys.register` - F1-F4 по умолчанию, `Cmd/Ctrl+Shift+N` из слушателя окна
// и сочетания, которые занимает меню приложения. Окна у пилота нет: нажатия и исход регистраций держатся в памяти плагина, чтобы тест и человек за Mac их видели.
// Условия `when` не названы: действуют умолчания ядра - не при автоповторе, не в поле ввода (терминал им не считается), не при открытом диалоге, как у кнопок Cyborg.

/** Кнопки по умолчанию и сочетание «новая сессия»: их Cyborg держит в слушателе окна. */
const BUTTONS: readonly (readonly [key: string, name: string])[] = [
  ['F1', 'F1'],
  ['F2', 'F2'],
  ['F3', 'F3'],
  ['F4', 'F4'],
  ['CmdOrCtrl+Shift+N', 'new-session'],
];

/** Сочетания, которые кнопка пользователя могла бы занять, а меню приложения уже занято: Cyborg ловил их ручным списком `RESERVED_*`. */
const TAKEN: readonly string[] = ['CmdOrCtrl+0', 'CmdOrCtrl+Shift+F', 'CmdOrCtrl+Shift+X', 'CmdOrCtrl+C', 'CmdOrCtrl+Q'];

const keysPilot: PluginModule = {
  async activate(ctx) {
    const presses: string[] = [];
    const outcomes: Record<string, string> = {};
    ctx.commands.register('keys-pilot.press', (name) => {
      presses.push(String(name));
      ctx.log(`нажато ${String(name)}`);
    });
    ctx.commands.register('keys-pilot.report', () => ({ presses: [...presses], outcomes: { ...outcomes } }));
    for (const [key, name] of BUTTONS) {
      const reg = await ctx.keys.register({ key, command: 'keys-pilot.press', args: [name] });
      outcomes[key] = reg.active ? 'active' : `lost:${reg.winner ?? '?'}`;
    }
    for (const key of TAKEN) {
      try {
        const reg = await ctx.keys.register({ key, command: 'keys-pilot.press', args: [key] });
        outcomes[key] = reg.active ? 'active' : `lost:${reg.winner ?? '?'}`;
      } catch (error) {
        outcomes[key] = (error as { code?: string }).code ?? 'error';
      }
    }
    ctx.log(`сочетания: ${JSON.stringify(outcomes)}`);
  },
};

export default keysPilot;

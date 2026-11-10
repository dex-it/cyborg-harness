/* eslint-disable no-console -- плагин стенда нарочно пишет в консоль хоста: ядро принимает этот вывод построчно (K-29) */
import type { PluginModule } from '../../src/plugin.ts';

// Плагин, который пишет в консоль процесса хоста: тесты K-29 смотрят, чьей строкой ядро их примет.
const plugin: PluginModule = {
  activate(ctx) {
    console.log(`${ctx.pluginId}: поднят`);
    ctx.commands.register(`${ctx.pluginId}.say`, (text) => {
      console.log(`${ctx.pluginId}: ${String(text)}`);
    });
    ctx.commands.register(`${ctx.pluginId}.warn`, () => {
      console.warn(`${ctx.pluginId}: осторожно`);
      process.stderr.write(`${ctx.pluginId}: ошибка\n`);
    });
    // Строка из таймера и из продолжения промиса относится к тому, кто их завёл, а не к тому, кто выполнялся на хосте в этот момент.
    ctx.commands.register(`${ctx.pluginId}.later`, () => {
      setTimeout(() => console.log(`${ctx.pluginId}: из таймера`), 40);
      void new Promise((resolve) => setTimeout(resolve, 60)).then(() => console.log(`${ctx.pluginId}: из продолжения`));
    });
  },
};

export default plugin;

import type { PluginModule } from '@cyborg-harness/contracts';
import { checkSettings, type Problem } from './check.ts';

// Пробный редактор (PL-05): файлы лежат в каталоге данных плагина, виду их отдают команды; схему настроек проверяет владелец, а не вид.
const SEED: Readonly<Record<string, string>> = {
  'settings.json': '{\n  "fontSize": 14,\n  "theme": "dark",\n  "keys": ["Ctrl+S"]\n}\n',
  // Ошибка типа в конце файла: маркер приходит из воркера TypeScript, поэтому его видно без ввода.
  'sample.ts': "// Подсветка и подсказки TypeScript работают в воркере Monaco.\nexport function greet(name: string): string {\n  return `Привет, ${name}`;\n}\n\nconsole.log(greet('Cyborg'));\nexport const broken: number = 'строка';\n",
  // Синтаксическая ошибка: маркер приходит из воркера json.
  'broken.json': '{\n  "name": ,\n}\n',
};

/** Вид просит файл по имени из списка, а не по пути: другое имя - отказ. */
function known(name: string): string {
  if (!Object.hasOwn(SEED, name)) throw new Error(`нет такого файла: ${name}`);
  return name;
}

const editor: PluginModule = {
  activate(ctx) {
    const path = (name: string) => `${ctx.os.paths.data}/${known(name)}`;
    const seeded = (async () => {
      await ctx.os.fs.mkdir(ctx.os.paths.data);
      for (const [name, text] of Object.entries(SEED)) {
        await ctx.os.fs.stat(path(name)).catch(() => ctx.os.fs.writeText(path(name), text));
      }
    })();
    ctx.commands.register('editor.files', async () => {
      await seeded;
      return Object.keys(SEED);
    });
    ctx.commands.register('editor.open', async (name) => {
      await seeded;
      return ctx.os.fs.readText(path(String(name)));
    });
    ctx.commands.register('editor.save', async (name, text) => {
      await seeded;
      await ctx.os.fs.writeText(path(String(name)), String(text));
      ctx.log(`сохранён ${String(name)}`);
    });
    // Схему проверяет владелец файла: вид показывает ответ маркерами и сам схему не знает.
    ctx.commands.register('editor.check', (name, text): readonly Problem[] => (known(String(name)) === 'settings.json' ? checkSettings(String(text)) : []));
    return undefined;
  },
};

export default editor;

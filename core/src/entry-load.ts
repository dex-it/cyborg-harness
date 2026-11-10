import { errorMessage } from './errors.ts';
import type { PluginModule } from './plugin.ts';

// T-10: точку входа плагина хост грузит через import() по пути, которого ядро заранее не знает. Отказ автор читает в журнале,
// поэтому сообщение называет файл и, для известных причин, что менять. Исходная ошибка остаётся в тексте и в cause.

/** Подсказка по коду ошибки Node или форме SyntaxError; пусто - причина неизвестна, остаётся сообщение Node. */
function hintFor(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  if (code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
    return 'Node снимает только стираемые типы: enum, namespace с кодом и параметры-свойства конструктора не работают; перепишите без них или соберите плагин (cyborg-plugin build)';
  }
  if (code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING') {
    return 'Node не снимает типы у файлов под node_modules; плагин-пакет поставляется собранным в .mjs (cyborg-plugin build)';
  }
  // ESM-код в области package.json с "type":"commonjs": Node читает файл как CommonJS и спотыкается на import/export.
  if (error.name === 'SyntaxError' && /\b(?:export|import)\b/.test(error.message)) {
    return 'похоже на ESM-код в области package.json с "type":"commonjs": задайте "type":"module" или назовите файл index.mjs';
  }
  return undefined;
}

/** Загружает модуль плагина и проверяет, что он отдаёт `export default { activate }`. */
export async function loadEntry(importer: (entry: string) => Promise<PluginModule>, entry: string): Promise<PluginModule> {
  let module: PluginModule;
  try {
    module = await importer(entry);
  } catch (error) {
    const hint = hintFor(error);
    throw new Error(`точка входа ${entry} не загрузилась: ${errorMessage(error)}${hint === undefined ? '' : ` (${hint})`}`, { cause: error });
  }
  // Импортёр отдаёт `default` как есть: модуль без default-экспорта приходит undefined, CommonJS без activate - чем угодно.
  if (typeof (module as Partial<PluginModule> | null | undefined)?.activate !== 'function') {
    throw new Error(`точка входа ${entry} загружена, но не отдаёт объект с activate: ожидается export default { activate(ctx) { ... } }`);
  }
  return module;
}

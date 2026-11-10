import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEntry } from '../src/entry-load.ts';
import type { PluginModule } from '../src/plugin.ts';

// T-10: автор видит в журнале «failed» с причиной. Сообщение Node ("Unexpected token 'export'") не говорит ни какой файл, ни что менять.

const ENTRY = 'file:///plugins/notes/index.ts';

function failing(code: string | undefined, message: string, name = 'Error'): () => Promise<PluginModule> {
  return () => {
    const error = Object.assign(new Error(message), { name, ...(code === undefined ? {} : { code }) });
    return Promise.reject(error);
  };
}

test('загруженный модуль отдаётся как есть', async () => {
  const module: PluginModule = { activate() {} };
  assert.equal(await loadEntry(() => Promise.resolve(module), ENTRY), module);
});

test('причина названа вместе с точкой входа и сохраняет сообщение Node', async () => {
  await assert.rejects(loadEntry(failing(undefined, 'boom'), ENTRY), (error: Error) => {
    assert.equal(error.message, `точка входа ${ENTRY} не загрузилась: boom`);
    assert.equal(error.cause instanceof Error, true, 'исходная ошибка осталась в cause');
    return true;
  });
});

test('enum и параметр-свойство: подсказка про стираемый синтаксис и сборку плагина', async () => {
  await assert.rejects(loadEntry(failing('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX', 'TypeScript enum is not supported in strip-only mode'), ENTRY), /enum is not supported.*стираемые типы.*enum.*параметры-свойства.*cyborg-plugin build/s);
});

test('.ts под node_modules: подсказка поставлять собранный .mjs', async () => {
  await assert.rejects(loadEntry(failing('ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING', 'Stripping types is currently unsupported for files under node_modules'), ENTRY), /node_modules.*\.mjs/s);
});

test('ESM-код в области "type":"commonjs": подсказка про type и index.mjs', async () => {
  for (const message of ["Unexpected token 'export'", 'Cannot use import statement outside a module']) {
    await assert.rejects(loadEntry(failing(undefined, message, 'SyntaxError'), ENTRY), /"type":"commonjs".*"type":"module".*index\.mjs/s, message);
  }
});

test('SyntaxError без import и export подсказки про тип модуля не получает', async () => {
  await assert.rejects(loadEntry(failing(undefined, "Unexpected token '}'", 'SyntaxError'), ENTRY), (error: Error) => {
    assert.doesNotMatch(error.message, /commonjs/);
    return true;
  });
});

test('модуль без default-экспорта с activate: сказано, что экспортировать', async () => {
  for (const [label, loaded] of [['undefined', undefined], ['null', null], ['{}', {}], ['activate не функция', { activate: 1 }]] as const) {
    await assert.rejects(loadEntry(() => Promise.resolve(loaded as never), ENTRY), /загружена, но не отдаёт.*export default \{ activate/s, label);
  }
});

test('не-ошибка в отказе тоже называет точку входа', async () => {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- причина: import() может отказать не Error, например throw строки на верхнем уровне модуля плагина
  await assert.rejects(loadEntry(() => Promise.reject('строка'), ENTRY), { message: `точка входа ${ENTRY} не загрузилась: строка` });
});

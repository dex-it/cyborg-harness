import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSettings } from '../plugins/editor/check.ts';

const valid = '{\n  "fontSize": 14,\n  "theme": "dark",\n  "keys": ["Ctrl+S"]\n}\n';

test('editor: корректные настройки - без замечаний', () => {
  assert.deepEqual(checkSettings(valid), []);
});

test('editor: замечание схемы стоит на строке и в столбце своего ключа', () => {
  assert.deepEqual(checkSettings('{\n  "fontSize": 99,\n  "theme": "dark",\n  "keys": []\n}'), [{ line: 2, column: 3, message: 'fontSize - число от 8 до 32' }]);
  assert.deepEqual(checkSettings(valid.replace('"dark"', '"blue"')), [{ line: 3, column: 3, message: 'theme - одна из: light, dark' }]);
  assert.deepEqual(checkSettings(valid.replace('["Ctrl+S"]', '[1]')), [{ line: 4, column: 3, message: 'keys - массив строк' }]);
});

test('editor: лишнее и пропавшее поле - замечания; не объект - одно замечание', () => {
  const extra = checkSettings(valid.replace('"keys"', '"zoom": 1, "keys"'));
  assert.deepEqual(extra.map((p) => p.message), ['неизвестное поле zoom']);
  const missing = checkSettings('{"theme": "dark", "keys": []}');
  assert.deepEqual(missing, [{ line: 1, column: 1, message: 'fontSize - число от 8 до 32' }]);
  assert.deepEqual(checkSettings('[]'), [{ line: 1, column: 1, message: 'настройки - объект' }]);
  assert.deepEqual(checkSettings('null'), [{ line: 1, column: 1, message: 'настройки - объект' }]);
});

test('editor: сломанный JSON - схема молчит, синтаксис показывает сам редактор', () => {
  assert.deepEqual(checkSettings('{"fontSize": '), []);
});

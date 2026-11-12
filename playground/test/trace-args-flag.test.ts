import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// K-33 (#224), осмотр: приложение берёт `--trace-args` только из командной строки. Электрон-часть главного процесса тестом не запускается, поэтому форму проверяет исходник.

const main = fs.readFileSync(path.resolve(import.meta.dirname, '../src/main/main.ts'), 'utf8');

test('main.ts: traceArgs читается из process.argv по TRACE_ARGS_FLAG и больше ниоткуда', () => {
  const sources = main.split('\n').filter((line) => /traceArgs/i.test(line) && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('/**'));
  assert.deepEqual(
    sources.map((line) => line.trim()),
    ['const traceArgs = process.argv.includes(TRACE_ARGS_FLAG);', 'traceArgs,'],
    'traceArgs объявлен из argv и передан службе; других мест (файлы настроек, воркспейс, IPC окна) нет',
  );
});

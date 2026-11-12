import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Данные плагина (имя файла, вывод команды, markdown) окно и элементы ядра выводят текстом, а не разметкой: в коде окна и ядра нет ни одного места,
// где строка становится HTML. Проверка статическая; поведение отрисовки смотрит дымовой тест окна.
const repo = path.join(import.meta.dirname, '..', '..');
const ROOTS = ['core/src', 'core/elements', 'electron/src', 'playground/src'];
const SINKS = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcdoc)\b|dangerouslySetInnerHTML/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') out.push(...sources(rel));
    } else if (/\.(ts|mjs|js|html)$/.test(entry.name) && !entry.name.includes('.test.')) out.push(rel);
  }
  return out;
}

function offenders(files: Record<string, string>): string[] {
  return Object.entries(files).flatMap(([file, text]) => text.split('\n').flatMap((line, i) => (SINKS.test(line) && !/^\s*(\/\/|\*)/.test(line) ? [`${file}:${String(i + 1)}`] : [])));
}

test('ST-3005/3: в core/, electron/src и playground/src нет мест, где строка становится разметкой (innerHTML, outerHTML, insertAdjacentHTML, document.write)', () => {
  const files = ROOTS.flatMap(sources);
  assert.ok(files.length > 50, 'обход ничего не нашёл: проверка не проверяет');
  assert.deepEqual(
    offenders(Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(repo, f), 'utf8')]))),
    [],
  );
});

test('проверка ловит то, что запрещает, и не принимает комментарий за код', () => {
  assert.deepEqual(offenders({ 'a.ts': 'el.innerHTML = name;\n// innerHTML нельзя\nel.insertAdjacentHTML("beforeend", x);' }), ['a.ts:1', 'a.ts:3']);
});

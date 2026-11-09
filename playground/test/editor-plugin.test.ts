import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext } from '@cyborg-harness/contracts';
import editor from '../plugins/editor/index.ts';

type Handler = (...args: unknown[]) => unknown;

/** Главная часть editor над фальшивым ctx: файлы в памяти, команды в таблице. */
function start() {
  const files = new Map<string, string>();
  const commands = new Map<string, Handler>();
  const logs: string[] = [];
  const ctx = {
    log: (line: string) => logs.push(line),
    commands: { register: (name: string, handler: Handler) => commands.set(name, handler) },
    os: {
      paths: { data: '/data' },
      fs: {
        mkdir: () => Promise.resolve(),
        stat: (path: string) => (files.has(path) ? Promise.resolve({}) : Promise.reject(new Error('нет файла'))),
        writeText: (path: string, text: string) => Promise.resolve(void files.set(path, text)),
        readText: (path: string) => (files.has(path) ? Promise.resolve(files.get(path)) : Promise.reject(new Error('нет файла'))),
      },
    },
  } as unknown as PluginContext;
  void editor.activate(ctx);
  const run = async (name: string, ...args: unknown[]) => {
    const handler = commands.get(name);
    assert.ok(handler, `нет команды ${name}`);
    return handler(...args);
  };
  return { files, run, logs };
}

test('editor: файлы создаются при первом обращении, сохранённое читается обратно', async () => {
  const first = start();
  assert.deepEqual(await first.run('editor.files'), ['settings.json', 'sample.ts', 'broken.json']);
  assert.match(String(await first.run('editor.open', 'settings.json')), /"fontSize": 14/);
  await first.run('editor.save', 'settings.json', '{"fontSize": 20}');
  assert.equal(await first.run('editor.open', 'settings.json'), '{"fontSize": 20}');
  assert.deepEqual(first.logs, ['сохранён settings.json']);
});

test('editor: имя вне списка - отказ, путь не собирается из ввода вида', async () => {
  const { run } = start();
  await assert.rejects(run('editor.open', '../../etc/passwd'), /нет такого файла/);
  await assert.rejects(run('editor.save', 'x.txt', 'a'), /нет такого файла/);
});

test('editor: editor.check отдаёт замечания схемы только для settings.json', async () => {
  const { run } = start();
  assert.deepEqual(await run('editor.check', 'settings.json', '{"fontSize": 99, "theme": "dark", "keys": []}'), [{ line: 1, column: 2, message: 'fontSize - число от 8 до 32' }]);
  assert.deepEqual(await run('editor.check', 'sample.ts', '{"fontSize": 99}'), []);
  await assert.rejects(run('editor.check', 'нет', ''), /нет такого файла/);
});

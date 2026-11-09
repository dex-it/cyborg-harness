import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Плагины для тестов инструмента: каталог во временном каталоге, зависимости - настоящие пакеты в его node_modules (без сети).
export const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-tool-'));
export const cleanup = (): void => fs.rmSync(scratch, { recursive: true, force: true });

let counter = 0;

export function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
}

/** Пакеты в `<dir>/node_modules`: имя -> файлы пакета (путь внутри пакета -> текст). */
export function packages(dir: string, deps: Readonly<Record<string, Readonly<Record<string, string>>>>): void {
  for (const [name, files] of Object.entries(deps)) write(path.join(dir, 'node_modules', name), files);
}

export const TINY_DEP = { 'package.json': '{"name":"tiny-dep","version":"1.0.0","main":"index.js"}', 'index.js': "module.exports = { shout: (text) => String(text).toUpperCase() + '!' };\n" };

export const MAIN_WITH_DEP = [
  "import { shout } from 'tiny-dep';",
  "import type { PluginModule } from '@cyborg-harness/contracts';",
  'const plugin: PluginModule = {',
  '  activate(ctx) {',
  "    ctx.commands.register('acme.dep.shout', (text: unknown) => shout(text));",
  '  },',
  '};',
  'export default plugin;',
  '',
].join('\n');

export const VIEW_WITH_DEP = ["import { shout } from 'tiny-dep';", 'export function mount(root: HTMLElement): void {', "  root.textContent = shout('вид');", '}', ''].join('\n');

/** Плагин `acme.dep` с командой `acme.dep.shout`; `files` дополняют и заменяют файлы по умолчанию (`null` - убрать), `manifest` - манифест. */
export function plugin(files: Readonly<Record<string, string | null>> = {}, manifest: Readonly<Record<string, unknown>> = {}, deps: Readonly<Record<string, Readonly<Record<string, string>>>> = { 'tiny-dep': TINY_DEP }): string {
  const dir = path.join(scratch, `p${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  const body = {
    id: 'acme.dep',
    version: '1.2.3',
    engines: { cyborg: '^1' },
    commands: { 'acme.dep.shout': { args: ['string'] } },
    ui: { views: { main: './ui/ui.js' } },
    config: { version: 1, schema: './config.schema.json' },
    ...manifest,
  };
  const all: Record<string, string | null> = {
    'manifest.json': JSON.stringify(body, null, 2),
    'index.ts': MAIN_WITH_DEP,
    'ui/ui.ts': VIEW_WITH_DEP,
    'ui/ui.css': 'body { color: red; }\n',
    'config.schema.json': '{"type":"object"}',
    ...files,
  };
  write(dir, Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => e[1] !== null)));
  packages(dir, deps);
  return dir;
}

export const fresh = (name: string): string => path.join(scratch, `${name}-${++counter}`);

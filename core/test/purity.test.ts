import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { COMPUTED, usesOf } from './imports.ts';

// ADR-CH-0001 пп. 1, 3, 4, 7; NFR-CH-1003: в ядре нет предметной области, Electron и npm-зависимостей. Без теста границу держало только ревью.
const core = path.resolve(import.meta.dirname, '..');
const src = path.join(core, 'src');
const CONTRACTS = '@cyborg-harness/contracts';

// git и cyborg сюда не входят: .git и область workspace.git общие для любой VCS, cyborg - имя продукта в формате файла и командах окна.
const DOMAIN = new Set(['session', 'tracker', 'jira', 'project', 'claude', 'agent', 'viewer', 'monaco']);

/** Слово из DOMAIN, которое в этом файле значит не предмет приложения. */
const ALLOWED: readonly { readonly file: string; readonly token: string; readonly reason: string }[] = [
  { file: 'net-transport.ts', token: 'agent', reason: 'параметр `agent` (пул соединений) в опциях node:http - это не агент Cyborg' },
  { file: 'net-transport.ts', token: 'Agent', reason: 'класс `Agent` в node:http(s) - пул соединений, а не агент Cyborg' },
  { file: 'net-transport.ts', token: 'user-agent', reason: 'заголовок HTTP `user-agent` - это не агент Cyborg' },
  { file: 'pty-host.ts', token: 'viewers', reason: 'зрители терминала - окна, подписанные на вывод pty, а не плагин viewer' },
];

/** Файл, которому вычисляемый импорт разрешён. */
const DYNAMIC: readonly { readonly file: string; readonly reason: string }[] = [
  { file: 'host-entry.ts', reason: 'хост грузит главную часть плагина по пути из манифеста - это и есть запуск кода плагина' },
];

const inside = (dir: string, target: string) => target === dir || target.startsWith(dir + path.sep);

export function importViolations(file: string, text: string): string[] {
  const found: string[] = [];
  for (const use of usesOf(file, text)) {
    const where = `${path.relative(core, file)}:${use.line} '${use.spec}'`;
    if (use.spec.startsWith('node:') || use.spec === CONTRACTS) continue;
    if (use.spec === COMPUTED && DYNAMIC.some((d) => d.file === path.basename(file))) continue;
    if (use.spec.startsWith('.')) {
      if (!inside(src, path.resolve(path.dirname(file), use.spec))) found.push(`${where}: модуль вне core/src`);
      continue;
    }
    found.push(`${where}: ядро импортирует только node:*, ${CONTRACTS} и свои модули`);
  }
  return found;
}

/** `lastProjectId` -> last, project, id; `agent-claude-code` -> agent, claude, code. */
const words = (token: string) =>
  token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase().replace(/s$/, ''));

export function domainViolations(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const base = path.basename(file);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const token = ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? node.text : ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) ? node.text : undefined;
    if (token !== undefined && !ALLOWED.some((a) => a.file === base && a.token === token)) {
      const hit = words(token).find((w) => DOMAIN.has(w));
      if (hit) found.push(`${path.relative(core, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} '${token}': предметное слово ${hit}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const sources = () =>
  fs
    .readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(m|c)?[tj]s$/.test(f) && !f.endsWith('.d.ts'))
    .map((f) => path.join(src, f));

describe('чистота ядра', () => {
  it('ST-1009/1: core/src импортирует только node:*, пакет контрактов и свои модули', () => {
    assert.deepEqual(
      sources().flatMap((f) => importViolations(f, fs.readFileSync(f, 'utf8'))),
      [],
    );
  });

  it('ST-1009/1: в идентификаторах и строках core/src нет предметных слов', () => {
    assert.deepEqual(
      sources().flatMap((f) => domainViolations(f, fs.readFileSync(f, 'utf8'))),
      [],
    );
  });

  it('у каждого исключения есть причина и оно ещё нужно', () => {
    for (const a of ALLOWED) {
      assert.ok(a.reason.length > 0, `${a.file} '${a.token}' без причины`);
      assert.ok(fs.readFileSync(path.join(src, a.file), 'utf8').includes(a.token), `${a.file} '${a.token}': исключение больше не нужно`);
    }
    for (const d of DYNAMIC) {
      assert.ok(d.reason.length > 0, `${d.file} без причины`);
      const file = path.join(src, d.file);
      assert.ok(usesOf(file, fs.readFileSync(file, 'utf8')).some((u) => u.spec === COMPUTED), `${d.file}: вычисляемого импорта больше нет`);
    }
  });

  it('core/package.json без зависимостей', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(manifest.dependencies, undefined);
  });

  it('проверка ловит то, что запрещает', () => {
    const file = path.join(src, 'x.ts');
    const text = [
      "import { app } from 'electron';",
      "import pty from 'node-pty';",
      "import { startPlugins } from '../../playground/src/main/plugins.ts';",
      "import { run } from '../examples/run.ts';",
      'const m = await import(name);',
      "import fs from 'fs';",
      "import type { PluginContext } from '@cyborg-harness/contracts';",
      "import { load } from './loader.ts';",
      "import path from 'node:path';",
    ].join('\n');
    assert.deepEqual(
      importViolations(file, text).map((v) => Number(/:(\d+) /.exec(v)?.[1])),
      [1, 2, 3, 4, 5, 6],
    );
    const named = ['const lastProjectId = 1;', "const id = 'agent-claude-code';", 'class TrackerSync {}', 'const viewers = new Set();', "const git = '.git';", 'const t = `sessions/${x}`;'].join('\n');
    assert.deepEqual(
      domainViolations(file, named).map((v) => Number(/:(\d+) /.exec(v)?.[1])),
      [1, 2, 3, 4, 6],
    );
    assert.deepEqual(domainViolations(path.join(src, 'pty-host.ts'), 'const viewers = new Set();'), [], 'исключение не действует в своём файле');
    assert.deepEqual(importViolations(path.join(src, 'host-entry.ts'), 'const m = await import(entry);'), [], 'исключение не действует в своём файле');
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { collect, generate, main, missingDocs, OUTPUT, render, SOURCES } from '../api-reference.ts';

// P-04: справочник ctx.* и UiContext собирается командой из TSDoc contracts/plugin.ts, view.ts, os.ts. Файл в репозитории обязан совпадать с собранным.
const repo = path.resolve(import.meta.dirname, '..', '..');
const roots: string[] = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const SAMPLE = `
/** Корень примера. */
export interface Ctx {
  /** Имя плагина. */
  readonly pluginId: string;
  /** Вложенный объект. */
  readonly commands: {
    /** Регистрирует команду. */
    register(name: string, handler: () => void): Disposable;
    run(name: string): Promise<unknown>;
  };
  /** Именованный. */
  readonly keys: Keys;
}

/** Ключи. */
export interface Keys {
  /**
   * Первая строка.
   * Вторая строка со ссылкой <группа>.
   */
  register(key: string): Promise<void>;
}

/** Уровень. */
export type Level = 'info' | 'warn';

export interface Disposable { dispose(): void }
`;

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-api-ref-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

describe('collect: разбор TSDoc', () => {
  const decls = collect([{ file: 'contracts/plugin.ts', text: SAMPLE }]);
  const byName = (name: string) => decls.find((d) => d.name === name);

  it('берёт интерфейсы и алиасы со своим описанием', () => {
    assert.deepEqual(decls.map((d) => d.name), ['Ctx', 'Keys', 'Level', 'Disposable']);
    assert.equal(byName('Ctx')?.doc, 'Корень примера.');
    assert.equal(byName('Level')?.kind, 'type');
    assert.equal(byName('Level')?.text, "'info' | 'warn'");
  });

  it('раскрывает вложенный объект в члены с путём через точку', () => {
    assert.deepEqual(byName('Ctx')?.members.map((m) => m.path), ['pluginId', 'commands', 'commands.register', 'commands.run', 'keys']);
    assert.equal(byName('Ctx')?.members.find((m) => m.path === 'commands.register')?.doc, 'Регистрирует команду.');
  });

  it('сохраняет несколько строк описания и подпись без комментария', () => {
    const member = byName('Keys')?.members.at(0);
    assert.deepEqual([member?.signature, member?.doc], ['register(key: string): Promise<void>', 'Первая строка. Вторая строка со ссылкой <группа>.']);
  });
});

describe('missingDocs: член без описания - находка', () => {
  it('называет член и вложенный член без TSDoc', () => {
    const decls = collect([{ file: 'contracts/plugin.ts', text: SAMPLE }]);
    assert.deepEqual(missingDocs(decls), ['Ctx.commands.run', 'Disposable', 'Disposable.dispose']);
  });
});

describe('render: страница справочника', () => {
  const decls = collect([{ file: 'contracts/plugin.ts', text: SAMPLE }]);
  const page = render(decls, { version: '1.2.3', date: '2030-01-02' });

  it('несёт версию и дату в шапке', () => {
    assert.match(page, /^---\ntitle: /);
    assert.match(page, /Версия API: 1\.2\.3/);
    assert.match(page, /2030-01-02/);
  });

  it('экранирует угловые скобки вне кода, код оставляет как есть', () => {
    assert.match(page, /ссылкой &lt;группа>/);
    assert.match(page, /`register\(key: string\): Promise<void>`/);
  });

  it('детерминирован: два прогона дают одно и то же', () => {
    assert.equal(render(decls, { version: '1.2.3', date: '2030-01-02' }), page);
  });
});

describe('main: проверка свежести файла', () => {
  const sources = Object.fromEntries(SOURCES.map((file) => [file, fs.readFileSync(path.join(repo, file), 'utf8')]));
  const meta = { 'contracts/package.json': '{"version":"9.9.9"}', 'contracts/CHANGELOG.md': '## 9.9.9 - 2031-05-06\n' };

  it('--write пишет файл, --check на свежем файле даёт код 0', () => {
    const root = tree({ ...sources, ...meta });
    assert.equal(main(['--write'], { root }).code, 0);
    const checked = main(['--check'], { root });
    assert.equal(checked.code, 0, checked.err);
    assert.match(fs.readFileSync(path.join(root, OUTPUT), 'utf8'), /Версия API: 9\.9\.9/);
  });

  it('--check на устаревшем файле даёт код 1 и называет команду обновления', () => {
    const root = tree({ ...sources, ...meta });
    main(['--write'], { root });
    fs.appendFileSync(path.join(root, OUTPUT), '\nправка руками\n');
    const stale = main(['--check'], { root });
    assert.equal(stale.code, 1);
    assert.match(stale.err, /устарел/);
    assert.match(stale.err, /npm run docs:api/);
  });

  it('--check, когда TSDoc в контрактах изменили, а файл не обновили, даёт код 1', () => {
    const root = tree({ ...sources, ...meta });
    main(['--write'], { root });
    const file = path.join(root, 'contracts/plugin.ts');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Снимает добавленное в обратном порядке при выгрузке плагина.', 'Другое описание.'));
    assert.equal(main(['--check'], { root }).code, 1);
  });

  it('--check без файла - код 1', () => {
    const root = tree({ ...sources, ...meta });
    assert.equal(main(['--check'], { root }).code, 1);
  });

  it('неизвестный флаг - исключение, а не молчаливый пропуск', () => {
    assert.throws(() => main(['--oops'], { root: tree({}) }), /неизвестный аргумент/);
  });
});

describe('репозиторий: справочник свежий и полный', () => {
  it('файл в репозитории совпадает с собранным из TSDoc (npm run docs:api)', () => {
    const committed = fs.readFileSync(path.join(repo, OUTPUT), 'utf8');
    assert.equal(committed, generate(repo), 'справочник устарел: выполните npm run docs:api');
  });

  it('у каждого публичного члена ctx и UiContext есть TSDoc', () => {
    const decls = collect(SOURCES.map((file) => ({ file, text: fs.readFileSync(path.join(repo, file), 'utf8') })));
    assert.deepEqual(missingDocs(decls), []);
  });

  it('в шапке версия пакета контрактов и дата записи в CHANGELOG', () => {
    const version = (JSON.parse(fs.readFileSync(path.join(repo, 'contracts/package.json'), 'utf8')) as { version: string }).version;
    const page = fs.readFileSync(path.join(repo, OUTPUT), 'utf8');
    assert.ok(page.includes(`Версия API: ${version}`));
    assert.match(page, /Дата: \d{4}-\d{2}-\d{2}/);
  });
});

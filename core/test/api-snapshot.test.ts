import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  checkSurface,
  compareSurfaces,
  constsOf,
  currentApiVersion,
  declarationsOf,
  elementsOf,
  extractSurface,
  KERNEL_SIDE,
  packageVersion,
  parseSurface,
  readEtalons,
  renderSurface,
  type ReadFile,
  type Surface,
} from '../scripts/api-surface.ts';

// T-06 (ADR-CH-0002, п. 3): в пределах мажорной версии член ctx не удаляется, элемент cy-* не удаляется и не меняет атрибуты. Эталон - core/test/api-snapshot/<версия API>.txt.
// Правила и процедура обновления - contracts/README.md, «Снимок API плагина (T-06)». Снимок деклараций пакета контрактов (P-01, check:contracts) остаётся рядом: он ловит любую правку, этот различает род изменения.
const repo = path.resolve(import.meta.dirname, '..', '..');
const read: ReadFile = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const apiVersion = currentApiVersion();
const etalons = readEtalons();

/** Исходники с правкой: подстрока `from` должна встретиться ровно один раз, иначе тест не про то, что думает. */
function edited(file: string, from: string, to: string): ReadFile {
  return (rel) => {
    const text = read(rel);
    if (rel !== file) return text;
    assert.equal(text.split(from).length - 1, 1, `${file}: «${from}» должно встретиться ровно один раз`);
    return text.replace(from, to);
  };
}

/** Линии версии пакета контрактов: разработка (`-dev`), кандидат в выпуск (`-rc.N`), выпуск после заморозки (без суффикса). */
const LINES = { dev: '1.0.0-dev', rc: '1.0.0-rc.1', final: '1.0.0' } as const;

/** Проверка текущих исходников (или испорченных `source`) против эталона на выбранной линии. */
function problemsOf(source: ReadFile, line: keyof typeof LINES): string[] {
  return checkSurface({ apiVersion, packageVersion: LINES[line], surface: extractSurface(source), etalons });
}

describe('эталон и исходники', () => {
  it('ST-5002/3: эталон текущей версии API совпадает с исходниками', () => {
    for (const line of ['dev', 'rc', 'final'] as const) assert.deepEqual(problemsOf(read, line), [], line);
    assert.deepEqual(checkSurface({ apiVersion, packageVersion: packageVersion(), surface: extractSurface(read), etalons }), [], 'версия пакета из репозитория');
  });

  it('ST-5002/3: эталон покрывает интерфейсы, поля манифеста и теги из задачи', () => {
    const { surface } = parseSurface(fs.readFileSync(path.join(import.meta.dirname, 'api-snapshot', `${apiVersion}.txt`), 'utf8'));
    for (const name of ['PluginContext', 'PluginModule', 'PluginDocuments', 'PluginWindow', 'PluginSystem', 'UiContext', 'UiModule', 'PluginOs', 'PluginPermissions', 'PluginManifest']) {
      assert.ok(surface.has(`interface ${name}`), `нет интерфейса ${name}`);
    }
    for (const key of ['member PluginContext.pluginId', 'member PluginContext.commands.run', 'member PluginModule.activate', 'member UiContext.dialogs.show', 'member PluginOs.fs', 'member PluginPermissions.fs.read']) {
      assert.ok(surface.has(key), `нет записи ${key}`);
    }
    for (const key of ['set TOP_LEVEL | provides', 'set TOP_LEVEL | permissions', 'member PluginManifest.provides', 'map WINDOW_COMMANDS | cyborg.window.focus-next', 'set element-tags | cy-button', 'set attributes cy-button | disabled', "variant ElementTag | 'cy-button'", "variant CoreErrorCode | 'NotFound'"]) {
      assert.ok(surface.has(key), `нет записи ${key}`);
    }
  });

  // K-21, пункт 2 задачи: что замораживается 1.0. Перечень записан здесь, а не выведен из эталона, иначе пропавшая из снимка группа не заметна.
  it('ST-5002/3: эталон покрывает весь перечень замораживаемого API', () => {
    const { surface } = parseSurface(fs.readFileSync(path.join(import.meta.dirname, 'api-snapshot', `${apiVersion}.txt`), 'utf8'));
    const keys = [...surface.keys()];
    const count = (prefix: string): number => keys.filter((k) => k.startsWith(prefix)).length;
    const frozen: Record<string, readonly string[]> = {
      'ctx плагина и вложенные объекты (contracts/plugin.ts)': ['member PluginContext.log', 'member PluginContext.keys', 'member PluginContext.views', 'member PluginContext.dialogs', 'member PluginContext.documents', 'member PluginContext.window', 'member PluginContext.system', 'member PluginContext.secrets', 'member PluginContext.os', 'member PluginModule.activate', 'member PluginKeys.register', 'member ViewChannel.post'],
      'ctx вида (contracts/view.ts)': ['member UiContext.channel', 'member UiContext.modal', 'member UiContext.dialogs', 'member UiContext.keys.of', 'member UiContext.state', 'member UiContext.terminal.open', 'member UiModule.mount'],
      'ctx.os и права (contracts/os.ts)': ['member PluginOs.fs', 'member PluginOs.process', 'member PluginOs.net', 'member PluginOs.pty', 'member PluginOs.notify', 'member PluginPermissions.fs.read', 'member PluginPermissions.notify', 'member PluginPermissions.ui.lock', 'member ProcessOptions.signal', 'member ProcessOptions.maxOutputBytes', 'member OsFs.watch', 'member OsFs.realpath'],
      'члены K-14, K-18, K-19': ['member OsNotify.show', 'member OsNotify.close', 'member NotifyOptions.onClick', 'member PluginWindow.setTitle', 'member PluginWindow.onFocusChange', 'member PluginWindow.focused', 'member PluginSystem.onBeforeQuit', 'member PluginSystem.onIdle', 'member OsUi.lock'],
      'манифест (core/src/manifest*.ts)': ['set TOP_LEVEL | contributes', 'set TOP_LEVEL | commands', 'set TOP_LEVEL | engines', 'member PluginManifest.contributes', 'member PluginManifest.ui.views', 'member PluginManifest.ui.placement', 'member CommandSpec.callers', 'member Guard.right', 'set AREAS | modal', 'set GUARD_RIGHTS | fs.read'],
      'вклады в меню (K-08)': ['interface Contributes', 'member Contributes.menus', 'interface MenuItemDecl', 'member MenuItemDecl.menu', 'member MenuItemDecl.command', 'member MenuItemDecl.order', 'member MenuItemDecl.accelerator', 'member MenuItemDecl.enabled', 'member MenuItemDecl.checked', 'member StateSource.contract', 'member StateSource.major', 'member StateSource.member', 'set MENU_NAMES | workspace', 'set MENU_NAMES | view', 'set MENU_NAMES | tools', 'set MENU_NAMES | window'],
      'элементы cy-*: свойства и события': ['map element-props cy-list | items', 'map element-props cy-tree | expanded', 'map element-props cy-tabs | tabs', 'map element-props cy-field | value', 'map element-props cy-button | disabled', 'set element-events cy-list | cy-select', 'set element-events cy-list | cy-activate', 'set element-events cy-tree | cy-toggle', 'set element-events cy-field | change'],
      'команды окна': ['map WINDOW_COMMANDS | cyborg.window.focus-next', 'map WINDOW_COMMANDS | cyborg.window.focus-prev'],
    };
    for (const [group, list] of Object.entries(frozen)) for (const key of list) assert.ok(surface.has(key), `${group}: нет записи ${key}`);
    assert.equal(count('set element-tags | '), 7, 'семь тегов cy-*');
    assert.equal(count("variant CoreErrorCode | '"), 13, 'коды CoreErrorCode: уменьшение - ломающее, увеличение - минор и новый эталон');
    assert.equal(count('map WINDOW_COMMANDS | '), 2);
  });

  it('снимок не зависит от порядка запуска: повторный разбор даёт тот же текст, текст читается обратно', () => {
    const text = renderSurface(apiVersion, extractSurface(read));
    assert.equal(text, renderSurface(apiVersion, extractSurface(read)));
    assert.equal(renderSurface(apiVersion, parseSurface(text).surface), text);
    assert.equal(text, etalons.get(apiVersion));
  });

  it('ElementTag, таблица ELEMENTS и эталон называют одни и те же теги', () => {
    const declared = [...declarationsOf(read('contracts/elements.ts'), 'contracts/elements.ts', ['ElementTag']).keys()].filter((k) => k.startsWith('variant ElementTag | ')).map((k) => k.slice("variant ElementTag | '".length, -1)).sort();
    const defined = [...elementsOf(read('core/elements/elements.ts')).keys()].filter((k) => k.startsWith('set element-tags | ')).map((k) => k.slice('set element-tags | '.length)).sort();
    assert.deepEqual(declared, defined);
    assert.ok(defined.length >= 7);
  });

  it('ST-5002/5: каждое имя в KERNEL_SIDE - интерфейс из снимка (опечатка или удалённый тип не остаются в списке)', () => {
    const surface = extractSurface(read);
    for (const name of KERNEL_SIDE) assert.ok(surface.has(`interface ${name}`), `KERNEL_SIDE: ${name} нет в снимке`);
  });
});

describe('порча исходников: линия разработки, кандидат и после заморозки', () => {
  const cases: readonly { readonly name: string; readonly source: ReadFile; readonly key: string }[] = [
    { name: 'удалено поле PluginContext', source: edited('contracts/plugin.ts', '  readonly pluginId: string;\n  /** Набор', '  /** Набор'), key: 'member PluginContext.pluginId' },
    { name: 'сменён тип аргумента метода ctx.commands.register', source: edited('contracts/plugin.ts', 'register(name: string, handler: CommandHandler): Disposable;', 'register(name: number, handler: CommandHandler): Disposable;'), key: 'member PluginContext.commands.register' },
    { name: 'удалён атрибут cy-button', source: edited('core/elements/elements.ts', "class CyButton extends CyElement {\n  static readonly observedAttributes = ['disabled'];", 'class CyButton extends CyElement {\n  static readonly observedAttributes = [];'), key: 'set attributes cy-button | disabled' },
    { name: 'удалён тег cy-spinner из таблицы элементов', source: edited('core/elements/elements.ts', ", 'cy-spinner': CySpinner } as const", ' } as const'), key: 'set element-tags | cy-spinner' },
    { name: 'удалён тег из ElementTag', source: edited('contracts/elements.ts', " | 'cy-spinner';", ';'), key: "variant ElementTag | 'cy-spinner'" },
    { name: 'удалено поле манифеста из TOP_LEVEL', source: edited('core/src/manifest.ts', "'ui', 'documents', 'host'", "'ui', 'host'"), key: 'set TOP_LEVEL | documents' },
    { name: 'удалено поле PluginManifest', source: edited('core/src/manifest.ts', '  readonly keybindings: readonly KeybindingSpec[];\n', ''), key: 'member PluginManifest.keybindings' },
    { name: 'свойство items у cy-list стало только для чтения', source: edited('core/elements/elements.ts', "  set items(items: readonly ListItem[]) {\n    this.#items = checkItems('cy-list', items);\n    this.render();\n  }\n\n", ''), key: 'map element-props cy-list | items' },
    { name: 'сменён тип свойства tabs у cy-tabs', source: edited('core/elements/elements.ts', 'get tabs(): readonly TabItem[] {', 'get tabs(): readonly TabItem[] | undefined {'), key: 'map element-props cy-tabs | tabs' },
    { name: 'событие cy-toggle переименовано', source: edited('core/elements/elements.ts', "this.fire('cy-toggle', { id, expanded: open });", "this.fire('cy-toggled', { id, expanded: open });"), key: 'set element-events cy-tree | cy-toggle' },
    { name: 'удалена команда окна', source: edited('core/src/window-layer.ts', "  'cyborg.window.focus-prev': 'Shift+F6',\n", ''), key: 'map WINDOW_COMMANDS | cyborg.window.focus-prev' },
    { name: 'сменено сочетание команды окна', source: edited('core/src/window-layer.ts', "'cyborg.window.focus-next': 'F6'", "'cyborg.window.focus-next': 'F7'"), key: 'map WINDOW_COMMANDS | cyborg.window.focus-next' },
    { name: 'удалён код отказа CoreErrorCode', source: edited('contracts/plugin.ts', "  | 'NotFound';", ';'), key: "variant CoreErrorCode | 'NotFound'" },
    { name: 'необязательное поле стало обязательным', source: edited('contracts/plugin.ts', 'readonly config?: PluginSection;', 'readonly config: PluginSection;'), key: 'member PluginContext.config' },
    { name: 'удалён член вложенного объекта ui.keys.of', source: edited('contracts/view.ts', '    of(command: string): string | undefined;\n', ''), key: 'member UiContext.keys.of' },
    { name: 'новый обязательный член PluginModule', source: edited('contracts/plugin.ts', '  activate(ctx: PluginContext)', '  readonly name: string;\n  activate(ctx: PluginContext)'), key: 'member PluginModule.name' },
    { name: 'новое обязательное поле параметров DocumentInit', source: edited('contracts/plugin.ts', 'export interface DocumentInit {\n  /** Заголовок вкладки. */\n  readonly title: string;', 'export interface DocumentInit {\n  readonly kind: string;\n  /** Заголовок вкладки. */\n  readonly title: string;'), key: 'member DocumentInit.kind' },
  ];

  for (const c of cases) {
    it(`ST-5002/1, ST-5002/3: ${c.name}: после заморозки - ломающее, у кандидата - новый кандидат, на линии разработки - просьба обновить эталон`, () => {
      const frozen = problemsOf(c.source, 'final');
      assert.equal(frozen.length, 1, frozen.join('\n'));
      assert.match(frozen[0]!, /ломающее изменение публичного API плагина в пределах мажорной версии 1/);
      assert.ok(frozen[0]!.includes(`ломающее: ${c.key}`), `в сообщении нет «${c.key}»:\n${frozen[0]}`);
      assert.match(frozen[0]!, /npm run snapshot:api/);
      assert.match(frozen[0]!, /2\.0\.0/);
      const dev = problemsOf(c.source, 'dev');
      assert.equal(dev.length, 1, dev.join('\n'));
      assert.match(dev[0]!, /линия разработки/);
      assert.ok(dev[0]!.includes(c.key));
      assert.match(dev[0]!, /npm run snapshot:api/);
      const rc = problemsOf(c.source, 'rc');
      assert.equal(rc.length, 1, rc.join('\n'));
      assert.match(rc[0]!, /кандидат 1\.0\.0-rc\.1/);
      assert.ok(rc[0]!.includes(c.key), `в сообщении нет «${c.key}»:\n${rc[0]}`);
      assert.match(rc[0]!, /1\.0\.0-rc\.2/);
      assert.match(rc[0]!, /npm run snapshot:api/);
      assert.match(rc[0]!, /npm run snapshot:contracts/);
    });
  }

  const additive: readonly { readonly name: string; readonly source: ReadFile; readonly key: string }[] = [
    { name: 'необязательный член в PluginContext', source: edited('contracts/plugin.ts', '  readonly pluginId: string;\n  /** Набор', '  readonly pluginId: string;\n  readonly extra?: string;\n  /** Набор'), key: 'member PluginContext.extra' },
    { name: 'необязательный член в PluginModule', source: edited('contracts/plugin.ts', '  activate(ctx: PluginContext)', '  readonly name?: string;\n  activate(ctx: PluginContext)'), key: 'member PluginModule.name' },
    { name: 'обязательный член в PluginContext (ядро его создаёт)', source: edited('contracts/plugin.ts', '  readonly pluginId: string;\n  /** Набор', '  readonly pluginId: string;\n  readonly extra: string;\n  /** Набор'), key: 'member PluginContext.extra' },
    { name: 'новый тег cy-badge', source: (rel) => (rel === 'contracts/elements.ts' ? read(rel).replace(" | 'cy-spinner';", " | 'cy-spinner' | 'cy-badge';") : rel === 'core/elements/elements.ts' ? read(rel).replace("'cy-spinner': CySpinner }", "'cy-spinner': CySpinner, 'cy-badge': CyEmpty }") : read(rel)), key: 'set element-tags | cy-badge' },
    { name: 'новый атрибут cy-button', source: edited('core/elements/elements.ts', "class CyButton extends CyElement {\n  static readonly observedAttributes = ['disabled'];", "class CyButton extends CyElement {\n  static readonly observedAttributes = ['disabled', 'variant'];"), key: 'set attributes cy-button | variant' },
    { name: 'новое свойство cy-empty', source: edited('core/elements/elements.ts', "class CyEmpty extends CyElement {\n  static readonly observedAttributes = ['heading'];", "class CyEmpty extends CyElement {\n  static readonly observedAttributes = ['heading'];\n  get extra(): string {\n    return '';\n  }"), key: 'map element-props cy-empty | extra' },
    { name: 'новое событие cy-list', source: edited('core/elements/elements.ts', "li.addEventListener('dblclick', () => this.fire('cy-activate', { id }));", "li.addEventListener('dblclick', () => this.fire('cy-activate', { id }));\n    li.addEventListener('contextmenu', () => this.fire('cy-menu', { id }));"), key: 'set element-events cy-list | cy-menu' },
    { name: 'новое поле манифеста', source: edited('core/src/manifest.ts', "'ui', 'documents', 'host'", "'ui', 'documents', 'menus', 'host'"), key: 'set TOP_LEVEL | menus' },
    { name: 'новый код отказа', source: edited('contracts/plugin.ts', "  | 'NotFound';", "  | 'NotFound'\n  | 'Busy';"), key: "variant CoreErrorCode | 'Busy'" },
  ];

  for (const c of additive) {
    it(`ST-5002/3: ${c.name}: после заморозки - просьба поднять минор и создать эталон, у кандидата - новый кандидат, а не отказ`, () => {
      const frozen = problemsOf(c.source, 'final');
      assert.equal(frozen.length, 1, frozen.join('\n'));
      assert.match(frozen[0]!, /публичный API плагина дополнен, а версия API и эталон - нет/);
      assert.ok(frozen[0]!.includes(`добавление: ${c.key}`), `в сообщении нет «${c.key}»:\n${frozen[0]}`);
      assert.match(frozen[0]!, /1\.1\.0/);
      assert.match(frozen[0]!, /npm run snapshot:api/);
      assert.doesNotMatch(frozen[0]!, /ломающее:/);
      const dev = problemsOf(c.source, 'dev');
      assert.equal(dev.length, 1, dev.join('\n'));
      assert.ok(dev[0]!.includes(c.key));
      assert.match(dev[0]!, /npm run snapshot:api/);
      const rc = problemsOf(c.source, 'rc');
      assert.equal(rc.length, 1, rc.join('\n'));
      assert.match(rc[0]!, /кандидат 1\.0\.0-rc\.1/);
      assert.ok(rc[0]!.includes(`добавление: ${c.key}`), `в сообщении нет «${c.key}»:\n${rc[0]}`);
      assert.match(rc[0]!, /1\.0\.0-rc\.2/);
    });
  }

  it('переименование параметра, комментарии и форматирование API не меняют', () => {
    const source: ReadFile = (rel) => {
      const text = read(rel);
      if (rel === 'contracts/plugin.ts') {
        return text
          .replace('register(name: string, handler: CommandHandler): Disposable;', '/** другой комментарий */\n    register(\n      title: string,\n      callback: CommandHandler,\n    ): Disposable;')
          .replace('log(message: string, level?: LogLevel): void;', 'log(text: string, severity?: LogLevel): void;');
      }
      if (rel === 'core/elements/elements.ts') return text.replace("observedAttributes = ['disabled'];", "observedAttributes = [\n    'disabled',\n  ];");
      return text;
    };
    for (const line of ['dev', 'rc', 'final'] as const) assert.deepEqual(problemsOf(source, line), [], line);
  });
});

describe('цепочка эталонов и версии', () => {
  const v1 = declarationsOf('export interface Ctx { readonly id: string; log(m: string): void }\nexport interface Mod { activate(ctx: Ctx): void }\n', 'a.ts');
  const grown = declarationsOf('export interface Ctx { readonly id: string; readonly extra?: string; log(m: string): void }\nexport interface Mod { activate(ctx: Ctx): void }\n', 'a.ts');
  const broken = declarationsOf('export interface Ctx { readonly id: string }\nexport interface Mod { activate(ctx: Ctx): void }\n', 'a.ts');
  const check = (api: string, surface: Surface, files: Record<string, Surface>, pkg = '1.0.0') =>
    checkSurface({ apiVersion: api, packageVersion: pkg, surface, etalons: new Map(Object.entries(files).map(([v, s]) => [v, renderSurface(v, s)])) });

  it('эталон на месте и совпадает - без замечаний', () => {
    assert.deepEqual(check('1.0.0', v1, { '1.0.0': v1 }), []);
  });

  it('минорная версия: новый эталон дополняет прежний - можно', () => {
    assert.deepEqual(check('1.1.0', grown, { '1.0.0': v1, '1.1.0': grown }), []);
  });

  it('ST-5003/5: ST-5002/5: минорная версия: эталон 1.1.0 с удалённым членом ломает 1.0.0 - ошибка, даже если исходники совпали с ним', () => {
    const problems = check('1.1.0', broken, { '1.0.0': v1, '1.1.0': broken });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /эталон 1\.1\.0\.txt ломает 1\.0\.0\.txt при той же мажорной версии 1/);
    assert.match(problems[0]!, /member Ctx\.log/);
  });

  it('новая мажорная версия может ломать прежнюю: цепочка идёт внутри мажорной', () => {
    assert.deepEqual(check('2.0.0', broken, { '1.0.0': v1, '2.0.0': broken }), []);
  });

  it('версия API повышена, а эталона для неё нет - ошибка с командой, поломка при той же мажорной версии названа', () => {
    const problems = check('1.1.0', broken, { '1.0.0': v1 });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /нет эталона для версии API 1\.1\.0/);
    assert.match(problems[0]!, /npm run snapshot:api/);
    assert.match(problems[0]!, /ломает 1\.0\.0/);
    assert.match(problems[0]!, /ломающее: member Ctx\.log/);
  });

  it('эталон новее версии API - ошибка', () => {
    const problems = check('1.0.0', v1, { '1.0.0': v1, '1.1.0': grown });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /1\.1\.0\.txt новее PLUGIN_API_VERSION 1\.0\.0/);
  });

  it('заголовок эталона не совпадает с именем файла, мусор вместо эталона - ошибка', () => {
    const wrong = checkSurface({ apiVersion: '1.0.0', packageVersion: '1.0.0', surface: v1, etalons: new Map([['1.0.0', renderSurface('1.0.1', v1)]]) });
    assert.match(wrong.join('\n'), /в заголовке версия 1\.0\.1, а в имени файла 1\.0\.0/);
    const junk = checkSurface({ apiVersion: '1.0.0', packageVersion: '1.0.0', surface: v1, etalons: new Map([['1.0.0', 'не эталон']]) });
    assert.match(junk.join('\n'), /нет строки-заголовка/);
    assert.match(junk.join('\n'), /нет эталона для версии API 1\.0\.0/);
  });

  it('несколько изменений в одном сообщении', () => {
    const problems = check('1.0.0', broken, { '1.0.0': v1 });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /ломающее: member Ctx\.log/);
  });
});

describe('род изменения', () => {
  const surface = (text: string): Surface => declarationsOf(text, 'x.ts');
  const kinds = (a: string, b: string) => compareSurfaces(surface(a), surface(b)).map((c) => `${c.kind}:${c.breaking ? 'breaking' : 'ok'}:${c.key}`);

  it('ST-5002/1, ST-5002/3: удаление и переименование члена - ломающие', () => {
    assert.deepEqual(kinds('export interface A { a: string }', 'export interface A { }'), ['removed:breaking:member A.a']);
    assert.deepEqual(kinds('export interface A { a: string }', 'export interface A { b: string }'), ['removed:breaking:member A.a', 'added:breaking:member A.b']);
  });

  it('ST-5002/1, ST-5002/3: смена типа члена и типа аргумента - ломающие, имя параметра - нет', () => {
    assert.deepEqual(kinds('export interface A { f(x: string): void }', 'export interface A { f(x: number): void }'), ['changed:breaking:member A.f']);
    assert.deepEqual(kinds('export interface A { f(x: string): void }', 'export interface A { f(y: string): void }'), []);
    assert.deepEqual(kinds('export interface A { f(x: string): void }', 'export interface A { f(x: string, y?: number): void }'), ['changed:breaking:member A.f']);
  });

  it('обязательный и необязательный член в типе, который строит плагин, и в типе, который строит ядро', () => {
    assert.deepEqual(kinds('export interface PluginModule { a(): void }', 'export interface PluginModule { a(): void; b?: string }'), ['added:ok:member PluginModule.b']);
    assert.deepEqual(kinds('export interface PluginModule { a(): void }', 'export interface PluginModule { a(): void; b: string }'), ['added:breaking:member PluginModule.b']);
    assert.deepEqual(kinds('export interface PluginContext { a(): void }', 'export interface PluginContext { a(): void; b: string }'), ['added:ok:member PluginContext.b']);
  });

  it('член нового интерфейса - добавление: расти ему было некуда', () => {
    assert.deepEqual(kinds('export interface A { a: string }', 'export interface A { a: string }\nexport interface B { x: string }'), ['added:ok:interface B', 'added:ok:member B.x']);
  });

  it('объединения: убранный вариант ломает, добавленный - нет', () => {
    assert.deepEqual(kinds("export type K = 'a' | 'b' | 'c'", "export type K = 'a' | 'c'"), ["removed:breaking:variant K | 'b'"]);
    assert.deepEqual(kinds("export type K = 'a'| 'b'", "export type K = 'a' | 'b' | 'c'"), ["added:ok:variant K | 'c'"]);
    assert.deepEqual(kinds("export interface A { k: 'a' | 'b' }", "export interface A { k: 'a' | 'b' | 'c' }"), ["added:ok:variant A.k | 'c'"]);
  });

  it('вложенный литерал раскладывается на члены, перегрузки метода собираются в одну запись', () => {
    const s = surface('export interface A { o: { f(): void; g?: number }; m(x: string): void; m(x: number): void }');
    assert.deepEqual([...s.keys()].sort(), ['interface A', 'member A.m', 'member A.o', 'member A.o.f', 'member A.o.g']);
    assert.equal(s.get('member A.o.g'), 'optional prop number');
    assert.match(s.get('member A.m') ?? '', / \|\| /);
  });

  it('наследование и параметры типа входят в запись интерфейса', () => {
    assert.equal(surface('export interface B<T> extends Z, A { }').get('interface B'), '<T> extends A, Z');
    assert.deepEqual(kinds('export interface B extends A { }', 'export interface B { }'), ['changed:breaking:interface B']);
  });

  it('неэкспортируемое объявление в снимок не попадает, отсутствующее имя из списка - ошибка', () => {
    assert.deepEqual([...surface('interface Hidden { a: string }').keys()], []);
    assert.throws(() => declarationsOf('export interface A {}', 'x.ts', ['A', 'Gone']), /нет экспортируемого объявления Gone/);
  });
});

describe('разбор констант и элементов', () => {
  it('множество, массив и таблица значений', () => {
    assert.deepEqual([...constsOf("const T = new Set(['b', 'a']);", { file: 'x.ts', name: 'T', kind: 'set' }).keys()], ['set T | b', 'set T | a']);
    assert.deepEqual([...constsOf("export const T = ['a', 'b'] as const;", { file: 'x.ts', name: 'T', kind: 'set' }).keys()], ['set T | a', 'set T | b']);
    assert.deepEqual([...constsOf("export const M = { 'x.y': 'F6', z: 'F7' };", { file: 'x.ts', name: 'M', kind: 'map' })], [['map M | x.y', 'F6'], ['map M | z', 'F7']]);
  });

  it('переименованная или изменившая вид константа - громкая ошибка, а не пустой снимок', () => {
    assert.throws(() => constsOf('const Other = new Set([]);', { file: 'x.ts', name: 'T', kind: 'set' }), /нет константы T/);
    assert.throws(() => constsOf('const T = new Set(names);', { file: 'x.ts', name: 'T', kind: 'set' }), /не массив/);
    assert.throws(() => constsOf('const T = new Set([1]);', { file: 'x.ts', name: 'T', kind: 'set' }), /не строку/);
    assert.throws(() => constsOf('const M = { a: 1 };', { file: 'x.ts', name: 'M', kind: 'map' }), /не строка/);
    assert.throws(() => constsOf('const M = { ...x };', { file: 'x.ts', name: 'M', kind: 'map' }), /не пару/);
  });

  it('атрибуты элемента берутся у предка, если свои не объявлены', () => {
    const src = [
      'class Base { static readonly observedAttributes = ["a", "b"]; }',
      'class Child extends Base {}',
      'class Own extends Base { static readonly observedAttributes = ["c"]; }',
      'class Plain {}',
      "const ELEMENTS = { 'x-child': Child, 'x-own': Own, 'x-plain': Plain } as const;",
    ].join('\n');
    assert.deepEqual([...elementsOf(src, 'e.ts').keys()], ['set element-tags | x-child', 'set attributes x-child | a', 'set attributes x-child | b', 'set element-tags | x-own', 'set attributes x-own | c', 'set element-tags | x-plain']);
    assert.throws(() => elementsOf("const ELEMENTS = { 'x-a': Missing };", 'e.ts'), /класс Missing/);
  });

  it('свойства и события элемента: открытые аксессоры и события из fire и Event, без приватных и защищённых, с наследованием', () => {
    const src = [
      'class Base {',
      '  get a(): string { return ""; }',
      '  set a(v: string) {}',
      '  get ro(): number { return 1; }',
      '  protected get hidden(): number { return 1; }',
      '  get #secret(): number { return 1; }',
      '  private get closed(): number { return 1; }',
      '  protected fire(t: string): void {}',
      '  protected run(): void { this.fire("base-event"); }',
      '}',
      'class Child extends Base {',
      '  set a(v: string) {}',
      '  get own(): readonly string[] { return []; }',
      '  set own(v: readonly string[]) {}',
      '  protected go(): void { this.dispatchEvent(new CustomEvent("x-custom")); this.dispatchEvent(new Event("change")); }',
      '  attributeChangedCallback(): void {}',
      '  connectedCallback(): void {}',
      '  focusRow(id: string): void {}',
      '}',
      "const ELEMENTS = { 'x-child': Child } as const;",
    ].join('\n');
    const got = elementsOf(src, 'e.ts');
    assert.deepEqual([...got].filter(([k]) => k.includes('element-props') || k.includes('element-events')), [
      ['map element-props x-child | a', 'get/set string'],
      ['map element-props x-child | focusRow', 'method (_: string) => void'],
      ['map element-props x-child | own', 'get/set readonly string[]'],
      ['map element-props x-child | ro', 'get number'],
      ['set element-events x-child | base-event', ''],
      ['set element-events x-child | change', ''],
      ['set element-events x-child | x-custom', ''],
    ]);
  });

  it('повтор записи в эталоне и дубль объявления - ошибка', () => {
    assert.throws(() => parseSurface('// plugin API 1.0.0\nmember A.a :: x\nmember A.a :: y\n'), /повторена/);
    assert.throws(() => declarationsOf('export interface A { a: string; a: number }', 'x.ts'), /дважды/);
  });
});

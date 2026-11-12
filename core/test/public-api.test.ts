import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { usesOf } from './imports.ts';

// T-09: что встраивающее приложение вправе импортировать из @cyborg-harness/core. Всё остальное внутреннее.
// Перечни ниже - договорённость, а не снимок: имя добавляют сюда осознанно, вместе с описанием в README ядра и SAD (раздел 1).
const core = path.resolve(import.meta.dirname, '..');
const root = path.resolve(core, '..');
const PACKAGE = '@cyborg-harness/core';

interface PublicEntry {
  /** Файл-вход в исходниках. */
  readonly source: string;
  /** Имена с рантаймом (функции, классы, константы). */
  readonly values: readonly string[];
  /** Только типы: в собранном JS их нет. */
  readonly types: readonly string[];
}

const ENTRIES: Readonly<Record<string, PublicEntry>> = {
  '.': {
    source: 'src/index.ts',
    values: [
      'CoreError',
      'Diagnostics',
      'OsGateway',
      'PLUGIN_API_VERSION',
      'PtyTable',
      'RecentWorkspaces',
      'SectionStore',
      'MENU_NAMES',
      'MENU_OWNER',
      'WINDOW_OWNER',
      'appendBounded',
      'claimInstance',
      'describeEntry',
      'describeOpenCommands',
      'describePermissions',
      'entryLevel',
      'entryPlugins',
      'forkHosts',
      'groupKilled',
      'inlineHosts',
      'inlinePtyHost',
      'keyOfInput',
      'load',
      'neighborInstances',
      'openWorkspace',
      'parseManifest',
      'pluginStatuses',
      'withFileLock',
      'workspaceKey',
    ],
    types: [
      'ArgSpec',
      'Boundary',
      'Claim',
      'Area',
      'CommandCallers',
      'CommandHandler',
      'CommandSpec',
      'Contributes',
      'ContractGraph',
      'ContractImpl',
      'ContractRegistry',
      'CoreErrorCode',
      'DiagnosticRecord',
      'DiagnosticsFs',
      'DiagnosticsInfo',
      'DiagnosticsOptions',
      'DisableOptions',
      'DisablePreview',
      'Disposable',
      'DocumentDecl',
      'DocumentRow',
      'EnabledChange',
      'ExitRecord',
      'ExportContext',
      'FileLockOptions',
      'GrantStore',
      'Guard',
      'GuardRight',
      'HostHandle',
      'InstanceOptions',
      'Importer',
      'JournalEntry',
      'KeptPty',
      'KeyInput',
      'KeyPress',
      'Kernel',
      'Keybinding',
      'KeybindingSpec',
      'Layer',
      'LayerStore',
      'LayoutEntry',
      'LayoutMark',
      'LoadOptions',
      'Lookup',
      'ManifestResult',
      'MemberGuards',
      'MenuEntry',
      'MenuItemDecl',
      'MenuName',
      'MigrateWorkspace',
      'Migrated',
      'NeighborInstance',
      'NeighborOptions',
      'NoticeEvents',
      'NoticeHandle',
      'NotifyLimits',
      'OpenResult',
      'OperationRecord',
      'OsEnvironment',
      'PluginContext',
      'PluginManifest',
      'PluginModule',
      'PluginPermissions',
      'PluginSection',
      'PluginState',
      'PluginStatus',
      'PluginsList',
      'Placement',
      'PreviousFailure',
      'Provider',
      'PtyBackend',
      'PtyProcess',
      'PtyWire',
      'Rejection',
      'ResourceLimits',
      'SectionDecl',
      'SectionHandle',
      'SectionResult',
      'SectionSpec',
      'SecretStore',
      'ShowNotice',
      'ShownDialog',
      'ShownModal',
      'SpawnHost',
      'SpawnPtyHost',
      'StateSource',
      'StreamRecord',
      'SystemEvent',
      'TerminalChannel',
      'TerminalView',
      'TraceRecord',
      'UninstallReport',
      'UserKeybinding',
      'WatchdogOptions',
      'WindowLock',
      'WindowSnapshot',
      'WindowTitle',
      'WireKind',
      'Workspace',
      'WorkspaceOptions',
    ],
  },
  './host': { source: 'src/index-host.ts', values: ['runHost'], types: ['HostOptions', 'Importer', 'Port'] },
  './host-entry': { source: 'src/host-entry.ts', values: [], types: [] },
  './pty-host': { source: 'src/index-pty-host.ts', values: ['groupKilled', 'nodeViewPort', 'runPtyHost'], types: ['Port', 'PtyBackend', 'PtyHost', 'PtyHostOptions', 'PtyProcess', 'ViewPort'] },
  './keys': { source: 'src/index-keys.ts', values: ['keyOfInput'], types: ['KeyInput'] },
  './ui-shell': {
    source: 'src/index-ui-shell.ts',
    values: ['connectView', 'keepFocus', 'mountModule'],
    types: ['FocusRoot', 'FocusWindow', 'TerminalEvent', 'TerminalOpened', 'ViewBridge', 'ViewTarget'],
  },
  './plugin-check': { source: 'src/index-plugin-check.ts', values: ['CHECKED_KEYS', 'ENTRY_FILES', 'checkPlugin', 'formatProblem', 'isTestPath'], types: ['CheckOptions', 'CheckReport', 'FileRef', 'ImportRules', 'Problem'] },
  './delivery': { source: 'src/index-delivery.ts', values: ['DELIVERY_FILE', 'readDelivery', 'verifyDelivery', 'writeDelivery'], types: ['DeliveryManifest'] },
  './window': { source: 'src/index-window.ts', values: ['WINDOW_OWNER'], types: ['Area', 'DisablePreview', 'DocumentRow', 'LayoutEntry', 'ShownDialog', 'ShownModal', 'WindowLock', 'WindowSnapshot', 'WindowTitle'] },
  './elements': { source: 'elements/elements.ts', values: ['defineElements'], types: [] },
};

/** Входы окна: их JS не вправе дойти до `node:*`. */
const BROWSER = ['./keys', './ui-shell', './window', './elements'];

/** Типы, которые торчат из публичных объявлений, но имени не получают: причина у каждого. */
const NOT_NAMED: Readonly<Record<string, string>> = {
  Endpoint: 'возврат runHost: приложение его не использует, состав методов не обещан',
  AskHost: 'позиционный параметр конструктора OsGateway: класс отдан для замеров и тестов, не для встраивания',
  Denial: 'позиционный параметр конструктора OsGateway (там же)',
  ConfigView: 'возврат позиционного параметра конструктора OsGateway (там же): слои config для права net, ADR-CH-0015',
  PtyExpiry: 'позиционный параметр конструктора OsGateway (там же)',
  PushMethod: 'позиционный параметр конструктора OsGateway (там же)',
  PtyTableOptions: 'позиционный параметр конструктора PtyTable: класс отдан для замеров и тестов, не для встраивания',
  PtyHostEvents: 'часть параметров конструктора PtyTable и OsGateway (там же)',
  PtyWatchdog: 'часть параметров конструктора PtyTable (там же)',
};

const manifest = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8')) as { exports: Record<string, string | { default: string }> };

/** Файл-вход в исходниках по цели `exports`: `./dist/src/index.js` -> `src/index.ts`. */
const sourceOfTarget = (target: string) => target.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts');
const defaultOf = (v: string | { default: string } | undefined) => (typeof v === 'string' ? v : (v?.default ?? ''));

const programs = new Map<string, ts.Program>();
function programFor(entry: PublicEntry): ts.Program {
  const dir = entry.source.startsWith('elements/') ? 'elements' : '.';
  const cached = programs.get(dir);
  if (cached) return cached;
  const configFile = path.join(core, dir, 'tsconfig.json');
  const config = ts.readConfigFile(configFile, (f) => ts.sys.readFile(f));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFile));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  programs.set(dir, program);
  return program;
}

interface Exported {
  readonly values: string[];
  readonly types: string[];
  /** Объявления, на которые указывают экспорты. */
  readonly targets: ts.Symbol[];
}

/** Экспорты входа глазами компилятора: что объявлено значением, а что только типом (`export type { … }` или тип по природе). */
function exportsOf(entry: PublicEntry): Exported {
  const program = programFor(entry);
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(path.join(core, entry.source));
  assert.ok(file, `нет файла ${entry.source}`);
  const symbol = checker.getSymbolAtLocation(file);
  const result: Exported = { values: [], types: [], targets: [] };
  for (const s of symbol ? checker.getExportsOfModule(symbol) : []) {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    const declaration = s.declarations?.[0];
    const typeOnly = declaration !== undefined && ts.isExportSpecifier(declaration) && (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly);
    (typeOnly || !(target.flags & ts.SymbolFlags.Value) ? result.types : result.values).push(s.name);
    result.targets.push(target);
  }
  result.values.sort();
  result.types.sort();
  return result;
}

const sorted = (names: readonly string[]) => [...names].sort();

describe('публичный API ядра: точки входа', () => {
  it('ST-6001/2: точки входа package.json совпадают с перечнем, а цели - с исходниками входов', () => {
    const declared = Object.keys(manifest.exports).filter((k) => k !== './package.json');
    assert.deepEqual(sorted(declared), sorted(Object.keys(ENTRIES)));
    for (const [name, entry] of Object.entries(ENTRIES)) {
      assert.equal(sourceOfTarget(defaultOf(manifest.exports[name])), entry.source, name);
      assert.ok(fs.existsSync(path.join(core, entry.source)), entry.source);
    }
  });

  for (const [name, entry] of Object.entries(ENTRIES)) {
    it(`${PACKAGE}${name === '.' ? '' : name.slice(1)}: экспорты равны перечню (значения и типы)`, () => {
      const found = exportsOf(entry);
      assert.deepEqual(found.values, sorted(entry.values), 'значения: лишнее или пропавшее имя - правь перечень в public-api.test.ts, README и SAD');
      assert.deepEqual(found.types, sorted(entry.types), 'типы: лишнее или пропавшее имя - правь перечень в public-api.test.ts, README и SAD');
    });
  }

  it('ST-6001/2: входы написаны явными именованными экспортами: `export *` во входе запрещён', () => {
    for (const [name, entry] of Object.entries(ENTRIES)) {
      const file = path.join(core, entry.source);
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const stars = source.statements.filter((s) => ts.isExportDeclaration(s) && s.exportClause === undefined);
      assert.equal(stars.length, 0, `${name}: export * в ${entry.source}`);
    }
  });

  it('собранный пакет отдаёт ровно те значения, что перечислены (core/dist)', async () => {
    for (const [name, entry] of Object.entries(ENTRIES)) {
      // Вход хоста запускает хост при импорте, элементы требуют DOM: их значения сверены компилятором выше.
      if (name === './host-entry' || name === './elements') continue;
      const target = path.join(core, defaultOf(manifest.exports[name]));
      assert.ok(fs.existsSync(target), `нет ${target}: запусти npm run build:core`);
      const loaded = (await import(pathToFileURL(target).href)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(loaded).sort(), sorted(entry.values), name);
    }
  });
});

/**
 * Типы, которые торчат из объявлений входов, но имени ни в одном входе не имеют: `Имя (файл) <- экспорт`.
 * Обход идёт по `.d.ts`, а не по исходникам: выведенный тип возврата (`function f() { return hidden; }`) в исходнике не записан,
 * а в объявлении компилятор выписывает его явно - это то, что видит потребитель пакета.
 */
function unnamedTypes(entryFiles: readonly string[], inside: (file: string) => boolean, allowed: Readonly<Record<string, string>>): string[] {
  const program = ts.createProgram([...entryFiles], { noEmit: true, skipLibCheck: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [] });
  const checker = program.getTypeChecker();
  const resolve = (s: ts.Symbol) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
  const modules = entryFiles.map((f) => {
    const file = program.getSourceFile(f);
    assert.ok(file, `нет ${f}`);
    const symbol = checker.getSymbolAtLocation(file);
    assert.ok(symbol, `${f}: не модуль`);
    return checker.getExportsOfModule(symbol);
  });
  const named = new Set(modules.flatMap((m) => m.map(resolve)));
  const leaks = new Set<string>();
  for (const exports of modules) {
    for (const exported of exports) {
      for (const declaration of resolve(exported).declarations ?? []) {
        const visit = (node: ts.Node): void => {
          // Тела и закрытые члены в .d.ts не попадают: только типы подписей.
          if (ts.isBlock(node) || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) || ('name' in node && ts.isPrivateIdentifier(node.name as ts.Node))) return;
          // `typeof KINDS` (значение) в объявления попадает без имени: имя нужно только типам.
          // Тип из другого модуля без импорта в этом файле компилятор выписывает как `import("./x.js").T`.
          const reference = ts.isTypeReferenceNode(node) ? node.typeName : ts.isExpressionWithTypeArguments(node) ? node.expression : ts.isImportTypeNode(node) && !node.isTypeOf ? node.qualifier : undefined;
          if (reference) {
            const raw = checker.getSymbolAtLocation(reference);
            const symbol = raw && resolve(raw);
            const where = symbol?.declarations?.[0]?.getSourceFile().fileName ?? '';
            if (symbol && inside(where) && !named.has(symbol) && !(symbol.flags & ts.SymbolFlags.TypeParameter) && !(symbol.name in allowed)) leaks.add(`${symbol.name} (${path.relative(core, where)}) <- ${exported.name}`);
          }
          ts.forEachChild(node, visit);
        };
        visit(declaration);
      }
    }
  }
  return [...leaks].sort();
}

describe('публичный API ядра: типы в сигнатурах', () => {
  const dist = path.join(core, 'dist') + path.sep;

  it('всё, что торчит из публичных объявлений (core/dist/**/*.d.ts), тоже имеет имя в какой-то точке входа', () => {
    const entryFiles = Object.keys(ENTRIES).map((name) => {
      const file = path.join(core, defaultOf(manifest.exports[name]).replace(/\.js$/, '.d.ts'));
      assert.ok(fs.existsSync(file), `нет ${file}: запусти npm run build:core`);
      return file;
    });
    // Прямой запуск файла минует pretest: без этой сверки тест судит прошлую сборку.
    const built = Math.min(...entryFiles.map((f) => fs.statSync(f).mtimeMs));
    const sources = [...fs.readdirSync(path.join(core, 'src'), { recursive: true, encoding: 'utf8' }).map((f) => path.join(core, 'src', f)), path.join(core, 'elements', 'elements.ts')];
    assert.deepEqual(sources.filter((f) => f.endsWith('.ts') && fs.statSync(f).mtimeMs > built).map((f) => path.relative(core, f)), [], 'core/dist старше исходников: запусти npm run build:core');
    assert.deepEqual(unnamedTypes(entryFiles, (f) => f.startsWith(dist), NOT_NAMED), [], 'безымянный тип в публичной сигнатуре: добавь его в перечень точки входа или убери из сигнатуры');
  });

  it('проверка ловит безымянный тип, в том числе выведенный (в исходнике его нет)', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-leak-'));
    try {
      const entry = path.join(work, 'entry.d.ts');
      // Так компилятор выписывает `function leakFn() { return hidden; }`: тип возврата явно, сам тип без экспорта.
      fs.writeFileSync(entry, 'interface Hidden {\n  a: 1;\n}\nexport declare function leakFn(): Hidden;\nexport declare function leakImport(): import("./inner.js").Inner;\nexport {};\n');
      fs.writeFileSync(path.join(work, 'inner.d.ts'), 'export interface Inner {\n  a: 1;\n}\n');
      assert.deepEqual(unnamedTypes([entry], (f) => f.startsWith(work), {}), [`Hidden (${path.relative(core, entry)}) <- leakFn`, `Inner (${path.relative(core, path.join(work, 'inner.d.ts'))}) <- leakImport`]);
      assert.deepEqual(unnamedTypes([entry], (f) => f.startsWith(work), { Hidden: 'проба', Inner: 'проба' }), []);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('публичный API ядра: окно без node:*', () => {
  /** Файлы JS, достижимые из входа по статическим и динамическим импортам внутри dist. */
  function reach(entryFile: string): { files: string[]; specs: string[] } {
    const files: string[] = [];
    const specs: string[] = [];
    const queue = [entryFile];
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (files.includes(file)) continue;
      files.push(file);
      for (const use of usesOf(file, fs.readFileSync(file, 'utf8'))) {
        specs.push(use.spec);
        if (use.spec.startsWith('.')) queue.push(path.resolve(path.dirname(file), use.spec));
      }
    }
    return { files, specs };
  }

  for (const name of BROWSER) {
    it(`${PACKAGE}${name.slice(1)}: в достижимом JS нет node:* и встроенных модулей`, () => {
      const { files, specs } = reach(path.join(core, defaultOf(manifest.exports[name])));
      assert.ok(files.length >= 1);
      const bad = specs.filter((s) => s.startsWith('node:') || isBuiltin(s));
      assert.deepEqual(bad, [], `достижимо из ${name}: ${files.map((f) => path.relative(core, f)).join(', ')}`);
    });
  }

  it('проверка достижимости ловит node:* в главном входе', () => {
    const { specs } = reach(path.join(core, defaultOf(manifest.exports['.'])));
    assert.ok(specs.some((s) => s.startsWith('node:')), 'главный вход тянет Node: именно поэтому окну нужны отдельные входы');
  });
});

/** Откуда и какие имена playground берёт у пакета: `[спецификатор, имя]`, `*` - пространство имён или значение по умолчанию. */
export function coreImports(file: string, text: string): { spec: string; name: string; line: number }[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: { spec: string; name: string; line: number }[] = [];
  for (const node of source.statements) {
    if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const spec = node.moduleSpecifier.text;
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
    const names = bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) ? bindings.elements.map((e) => (e.propertyName ?? e.name).text) : ['*'];
    for (const name of names) found.push({ spec, name, line });
  }
  return found;
}

/** Нарушения границы в файле потребителя: глубже точек входа, неизвестный вход, имя вне перечня входа. */
export function boundaryViolations(file: string, text: string, rel: string): string[] {
  const found: string[] = [];
  for (const use of usesOf(file, text)) {
    const where = `${rel}:${use.line} '${use.spec}'`;
    if (/(^|\/)core\/(src|dist|elements)\//.test(use.spec) || use.spec.startsWith(`${PACKAGE}/dist`) || use.spec.startsWith(`${PACKAGE}/src`)) found.push(`${where}: глубже точек входа`);
    else if (use.spec === PACKAGE || use.spec.startsWith(`${PACKAGE}/`)) {
      const entry = `.${use.spec.slice(PACKAGE.length)}`;
      if (!(entry in ENTRIES)) found.push(`${where}: нет такой точки входа`);
    }
  }
  // Путь, собранный из частей (`join(repo, 'core', 'src', …)`), статика импортов не видит.
  text.split('\n').forEach((l, i) => {
    if (/(['"`])core\1\s*,\s*(['"`])(src|dist|elements)\2/.test(l)) found.push(`${rel}:${i + 1} путь в core/${/['"`]core['"`]\s*,\s*['"`](\w+)['"`]/.exec(l)?.[1] ?? ''} собран из частей`);
    // `new URL('…/core/src/…', import.meta.url)` - тоже путь мимо пакета, но не импорт.
    if (/new URL\(\s*['"`][^'"`]*core\/(src|dist|elements)\//.test(l)) found.push(`${rel}:${i + 1} путь в core/ через new URL`);
  });
  // Любая другая строка с путём в core/src, dist или elements (fork, readFile, spawn): тоже мимо пакета. Строки, уже названные выше, не дублируем.
  text.split('\n').forEach((l, i) => {
    if (/['"`][^'"`\n]*core\/(src|dist|elements)\//.test(l) && !found.some((f) => f.startsWith(`${rel}:${i + 1} `))) found.push(`${rel}:${i + 1} путь в core/ строкой`);
  });
  for (const { spec, name, line } of coreImports(file, text)) {
    if (spec !== PACKAGE && !spec.startsWith(`${PACKAGE}/`)) continue;
    const entry = ENTRIES[`.${spec.slice(PACKAGE.length)}`];
    if (entry && name !== '*' && !entry.values.includes(name) && !entry.types.includes(name)) found.push(`${rel}:${line} '${spec}': ${name} вне перечня входа`);
  }
  return found;
}

/** Файлы playground, которым внутренности ядра нужны по делу: замер самого ядра. Каждое исключение - с причиной и сроком. */
const INTERNAL: Readonly<Record<string, string>> = {
  'playground/src/main/spike-gateway.ts': 'замер шлюза берёт net-transport (guardedLookup, isLocalAddress, closePools, transport) из core/src; уедет к замерам ядра вместе с остальными (не T-09)',
  'electron/test/boundary.test.ts': 'пробные строки проверки границы адаптера намеренно ведут вглубь ядра: проверка должна их ловить',
  'playground/scripts/spike-pty-restore.mjs': 'замер хвоста pty берёт Tail и BACKLOG_LIMIT из core/src/pty.ts; уедет к замерам ядра вместе с остальными (не T-09)',
};

describe('публичный API ядра: потребители в репозитории', () => {
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === 'node_modules' || e.name === 'dist') return [];
      const full = path.join(dir, e.name);
      return e.isDirectory() ? files(full) : /\.(ts|mjs)$/.test(e.name) ? [full] : [];
    });
  }

  it('ST-6001/1: playground и адаптер Electron берут ядро только через точки входа пакета и только их именами', () => {
    const all = ['playground', 'electron'].flatMap((dir) => files(path.join(root, dir)));
    assert.ok(all.length > 70, `файлов playground и electron: ${all.length}`);
    const bad = all.flatMap((f) => (path.relative(root, f) in INTERNAL ? [] : boundaryViolations(f, fs.readFileSync(f, 'utf8'), path.relative(root, f))));
    assert.deepEqual(bad, []);
  });

  it('исключения из границы живы: файл на месте и по-прежнему лезет вглубь ядра', () => {
    for (const rel of Object.keys(INTERNAL)) {
      const file = path.join(root, rel);
      assert.ok(fs.existsSync(file), `${rel}: файла нет - убери исключение`);
      assert.notDeepEqual(boundaryViolations(file, fs.readFileSync(file, 'utf8'), rel), [], `${rel}: больше не лезет вглубь - убери исключение`);
    }
  });

  it('проверка ловит то, что запрещает', () => {
    const text = [
      "import { load } from '@cyborg-harness/core';",
      "import { readJson } from '@cyborg-harness/core';",
      "import { Kernel } from '../../core/src/loader.ts';",
      "import { WindowLayer } from '@cyborg-harness/core/window';",
      "import { x } from '@cyborg-harness/core/dist/src/index.js';",
      "import { y } from '@cyborg-harness/core/nothing';",
      "import type { WindowSnapshot } from '@cyborg-harness/core/window';",
      "import { FakePty } from '../../testing/src/fake-pty.ts';",
      "export { runHost } from '@cyborg-harness/core/host';",
      "import { elements } from '../../core/elements/elements.ts';",
      "const { Tail } = await import(join(repo, 'core', 'src', 'pty.ts'));",
      "const entry = fileURLToPath(new URL('../../core/src/host-entry.ts', import.meta.url));",
      "const fixture = new URL(`../../core/test/fixtures/x.ts`, import.meta.url);",
      "const host = fork('../../core/src/host-entry.ts');",
      "await readFile('core/dist/src/index.js');",
    ].join('\n');
    const found = boundaryViolations('/x.ts', text, 'x.ts').map((v) => Number(/:(\d+) /.exec(v)?.[1]));
    assert.deepEqual(found.sort((a, b) => a - b), [2, 3, 4, 5, 6, 10, 11, 12, 14, 15]);
  });
});

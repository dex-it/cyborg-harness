import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';

// P-03: что приложение вправе импортировать из @cyborg-harness/electron. Остальное в пакете внутреннее.
// Перечень - договорённость, а не снимок: имя добавляют сюда осознанно, вместе с описанием в README адаптера.
const pkg = path.resolve(import.meta.dirname, '..');

interface PublicEntry {
  /** Файл-вход в исходниках. */
  readonly source: string;
  readonly values: readonly string[];
  readonly types: readonly string[];
}

const ENTRIES: Readonly<Record<string, PublicEntry>> = {
  '.': {
    source: 'src/index.ts',
    values: [
      'PluginsService',
      'USER_PLUGINS_FLAG',
      'VIEW_CSP',
      'alertNotification',
      'appMenuTemplate',
      'bindAppMenu',
      'bindWindow',
      'discoverPlugins',
      'electronOs',
      'framesOf',
      'guardNavigation',
      'quitAfterPlugins',
      'registerViewChannels',
      'registerViewScheme',
      'registerWindowChannels',
      'resolveStaticFile',
      'resolveViewRequest',
      'restarts',
      'serveViews',
      'showWindow',
      'singleInstance',
      'startPlugins',
      'utilityHosts',
      'utilityPtyHost',
      'viewChannel',
      'watchPower',
      'watchTheme',
      'windowChannel',
      'windowEvents',
      'workspaceInfo',
    ],
    types: [
      'AppMenuItem',
      'Discovered',
      'ElectronOsOptions',
      'PluginUi',
      'PluginsEvents',
      'PortPair',
      'RestartFlags',
      'RestartOptions',
      'Restarts',
      'ServeViewsOptions',
      'ServiceOptions',
      'StartOptions',
      'UtilityHosts',
      'UtilityPtyHost',
      'ViewChannelsOptions',
      'ViewCsp',
      'ViewGroups',
      'ViewRequest',
      'WindowChannelsOptions',
    ],
  },
  './host-entry': { source: 'src/host-entry.ts', values: [], types: [] },
  './pty-host-entry': { source: 'src/pty-host-entry.ts', values: [], types: [] },
  './preload': { source: 'src/index-preload.ts', values: ['exposeViewBridge', 'inViewFrame', 'inWindowDocument', 'viewBridge', 'windowApi'], types: ['WindowApi'] },
  './window': {
    source: 'src/index-window.ts',
    values: ['PATH_MIME', 'VIEW_SCHEME', 'WindowLayerView', 'groupOfOrigin', 'viewOrigin'],
    types: ['FeedLine', 'KeptPtyRow', 'KeyRow', 'LayoutRow', 'PluginJournalLine', 'PluginOrigin', 'PluginRow', 'PluginState', 'PluginsSnapshot', 'Reply', 'TerminalEvent', 'ViewBridge', 'ViewDrop', 'WindowApi', 'WindowPort', 'WorkspaceInfo'],
  },
};

/** Файлы, которые пакет отдаёт как есть (собранная оболочка вида), а не как модули. */
const FILES = ['./shell/shell.js', './shell/shell.css'];

const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')) as { exports: Record<string, string | { default: string }> };
const defaultOf = (v: string | { default: string } | undefined) => (typeof v === 'string' ? v : (v?.default ?? ''));
const sorted = (names: readonly string[]) => [...names].sort();

let program: ts.Program | undefined;
function exportsOf(entry: PublicEntry): { values: string[]; types: string[] } {
  if (!program) {
    const configFile = path.join(pkg, 'tsconfig.json');
    const config = ts.readConfigFile(configFile, (f) => ts.sys.readFile(f));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, pkg);
    program = ts.createProgram(parsed.fileNames, parsed.options);
  }
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(path.join(pkg, entry.source));
  assert.ok(file, `нет файла ${entry.source}`);
  const symbol = checker.getSymbolAtLocation(file);
  const values: string[] = [];
  const types: string[] = [];
  for (const s of symbol ? checker.getExportsOfModule(symbol) : []) {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    const declaration = s.declarations?.[0];
    const typeOnly = declaration !== undefined && ts.isExportSpecifier(declaration) && (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly);
    (typeOnly || !(target.flags & ts.SymbolFlags.Value) ? types : values).push(s.name);
  }
  return { values: values.sort(), types: types.sort() };
}

describe('публичный API адаптера Electron', () => {
  it('точки входа package.json совпадают с перечнем, цели существуют после сборки', () => {
    const declared = Object.keys(manifest.exports).filter((k) => k !== './package.json' && !FILES.includes(k));
    assert.deepEqual(sorted(declared), sorted(Object.keys(ENTRIES)));
    for (const [name, entry] of Object.entries(ENTRIES)) {
      const target = defaultOf(manifest.exports[name]);
      assert.equal(target.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts'), entry.source, name);
      assert.ok(fs.existsSync(path.join(pkg, entry.source)), entry.source);
      assert.ok(fs.existsSync(path.join(pkg, target)), `нет ${target}: запусти npm run build:electron`);
    }
    for (const file of FILES) assert.ok(fs.existsSync(path.join(pkg, defaultOf(manifest.exports[file]))), `нет ${file}: запусти npm run build:electron`);
  });

  for (const [name, entry] of Object.entries(ENTRIES)) {
    it(`@cyborg-harness/electron${name === '.' ? '' : name.slice(1)}: экспорты равны перечню (значения и типы)`, () => {
      const found = exportsOf(entry);
      assert.deepEqual(found.values, sorted(entry.values), 'значения: лишнее или пропавшее имя - правь перечень в electron/test/public-api.test.ts и README адаптера');
      assert.deepEqual(found.types, sorted(entry.types), 'типы: лишнее или пропавшее имя - правь перечень в electron/test/public-api.test.ts и README адаптера');
    });
  }

  it('входы написаны явными именованными экспортами: `export *` запрещён', () => {
    for (const [name, entry] of Object.entries(ENTRIES)) {
      const file = path.join(pkg, entry.source);
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const stars = source.statements.filter((s) => ts.isExportDeclaration(s) && s.exportClause === undefined);
      assert.equal(stars.length, 0, `${name}: export * в ${entry.source}`);
    }
  });

  it('вход окна не тянет node:* и electron', () => {
    const seen = new Set<string>();
    const queue = [path.join(pkg, defaultOf(manifest.exports['./window']))];
    const bad: string[] = [];
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (seen.has(file)) continue;
      seen.add(file);
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/^(?:import|export)\b[^;'"]*?from\s*'([^']+)';?$|^import\s*'([^']+)';?$/gm)) {
        const spec = m[1] ?? m[2] ?? '';
        if (spec.startsWith('.')) queue.push(path.resolve(path.dirname(file), spec));
        else bad.push(`${path.relative(pkg, file)}: ${spec}`);
      }
    }
    assert.ok(seen.size >= 3, `файлов в графе: ${String(seen.size)}`);
    assert.deepEqual(bad, []);
  });
});

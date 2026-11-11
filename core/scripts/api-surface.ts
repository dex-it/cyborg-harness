import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// T-06: снимок публичного API плагина с различением рода изменения. Поверх снимка деклараций пакета контрактов (P-01, contracts/api-snapshot.txt):
// тот ловит любую правку деклараций, этот знает, удаление это или добавление, и добавляет то, чего в пакете нет (поля манифеста, теги и атрибуты cy-*, команды окна).
// Разбор синтаксический (без проверки типов): печатаются типы как написаны, имена параметров отбрасываются, форматирование и комментарии не влияют на текст.

const repo = path.resolve(import.meta.dirname, '..', '..');
/** Каталог эталонов: файл на версию API, `<версия>.txt`. */
export const ETALON_DIR = path.join(repo, 'core', 'test', 'api-snapshot');

const NOTE = '// Снимок публичного API плагина (ctx, вид, манифест, элементы cy-*); правила - contracts/README.md, раздел «Снимок API плагина (T-06)». Обновление: npm run snapshot:api.\n';
const HEADER = /^\/\/ plugin API (\S+)\n/;
const SEP = ' :: ';

/** Ключ записи -> текст. Ключ начинается с рода записи: `interface`, `alias`, `member`, `variant`, `set`, `map`. */
export type Surface = ReadonlyMap<string, string>;

export interface Source {
  readonly file: string;
  /** Имена объявлений; без списка - все экспортируемые интерфейсы и алиасы файла. */
  readonly only?: readonly string[];
}

/** Объявления типов, чьи члены входят в снимок. */
export const TYPE_SOURCES: readonly Source[] = [
  { file: 'contracts/plugin.ts' },
  { file: 'contracts/view.ts' },
  { file: 'contracts/os.ts' },
  { file: 'contracts/elements.ts' },
  { file: 'core/src/manifest.ts', only: ['PluginManifest', 'SectionDecl', 'ArgSpec', 'CommandSpec', 'CommandCallers', 'KeybindingSpec'] },
  { file: 'core/src/manifest-layout.ts', only: ['Placement', 'DocumentDecl', 'Area'] },
  { file: 'core/src/via-contract.ts', only: ['Guard', 'GuardRight', 'MemberGuards'] },
];

export interface ConstSource {
  readonly file: string;
  readonly name: string;
  /** `set` - множество строк (`new Set([...])` или массив), `map` - объект строка -> строка. */
  readonly kind: 'set' | 'map';
}

/** Множества и таблицы значений: ключи манифеста, области окна, права `guard`, команды окна. */
export const CONST_SOURCES: readonly ConstSource[] = [
  { file: 'core/src/manifest.ts', name: 'TOP_LEVEL', kind: 'set' },
  { file: 'core/src/manifest-layout.ts', name: 'AREAS', kind: 'set' },
  { file: 'core/src/via-contract.ts', name: 'GUARD_RIGHTS', kind: 'set' },
  { file: 'core/src/window-layer.ts', name: 'WINDOW_COMMANDS', kind: 'map' },
];

export const ELEMENTS_FILE = 'core/elements/elements.ts';

/**
 * Типы, объекты которых создаёт ядро и отдаёт плагину (`ctx` и его части, результаты и разобранный манифест): новый обязательный член в них - добавление.
 * Всё остальное - то, что плагин строит и передаёт (`PluginModule`, параметры вызовов, данные для элементов) или реализует: новый обязательный член ломает такой плагин,
 * поэтому по умолчанию он считается ломающим. Ошибка в эту сторону безопасна: она просит повысить мажор лишний раз, а не пропускает поломку.
 * Разобранный манифест здесь потому, что поле с умолчанием (пустой набор) в типе обязательно, а в JSON плагина - нет; обязательное поле JSON ядро проверяет в `parseManifest`, и снимок его не видит (README, «Что снимок не видит»).
 */
export const KERNEL_SIDE: ReadonlySet<string> = new Set([
  'PluginContext', 'PluginKeys', 'KeyRegistration', 'PluginSection', 'PluginDocuments', 'DocumentInfo', 'PluginWindow', 'PluginSystem', 'DisposableStore', 'Provider',
  'PluginOs', 'OsFs', 'OsSecrets', 'OsPty', 'OsNotify', 'OsDialog', 'OsUi', 'UiLock', 'PluginSecrets', 'HttpServer', 'PtyHandle', 'PtyInfo', 'PtyExit',
  'DirEntry', 'FileStat', 'FileSlice', 'ProcessResult', 'HttpResponse', 'ServeRequest',
  'UiContext', 'UiTerminal', 'FeedLine', 'Reply', 'ViewDrop', 'ItemEventDetail', 'ToggleEventDetail',
  'PluginManifest', 'SectionDecl', 'ArgSpec', 'CommandSpec', 'KeybindingSpec', 'Placement', 'DocumentDecl', 'Guard',
]);

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** Пробелы, переносы и точка с запятой перед `}` не меняют текст: форматирование принтера не должно «плыть» вместе с версией TypeScript. */
function norm(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/; ?\}/g, ' }').replace(/ +\}/g, ' }').trim();
}

/** Узел без имён параметров: переименование параметра API не меняет (README, таблица «Что повышает какую версию»: опечатка в имени параметра - патч). */
function withoutParamNames<T extends ts.Node>(node: T): T {
  const result = ts.transform(node, [
    (context) => (root) => {
      const visit = (n: ts.Node): ts.Node => {
        const visited = ts.visitEachChild(n, visit, context);
        if (ts.isParameter(visited)) return context.factory.updateParameterDeclaration(visited, visited.modifiers, visited.dotDotDotToken, context.factory.createIdentifier('_'), visited.questionToken, visited.type, visited.initializer);
        return visited;
      };
      return ts.visitNode(root, visit) as T;
    },
  ]);
  const out = result.transformed[0];
  result.dispose();
  if (out === undefined) throw new Error('снимок API: преобразование узла не вернуло результата');
  return out;
}

function print(node: ts.Node, sf: ts.SourceFile): string {
  return norm(printer.printNode(ts.EmitHint.Unspecified, withoutParamNames(node), sf));
}

function has(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

function memberName(name: ts.PropertyName, sf: ts.SourceFile): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text : name.getText(sf);
}

function typeParams(node: { readonly typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> | undefined }, sf: ts.SourceFile): string {
  return node.typeParameters ? `<${node.typeParameters.map((p) => print(p, sf)).join(', ')}>` : '';
}

/** Сигнатура без имён параметров: `<K extends X>(_: K, _?: string) => R`. */
function signature(node: ts.SignatureDeclaration, sf: ts.SourceFile): string {
  const type = node.type ?? ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
  return print(ts.factory.createFunctionTypeNode(node.typeParameters, node.parameters, type), sf);
}

function unionOf(type: ts.TypeNode): readonly ts.TypeNode[] | undefined {
  const inner = ts.isParenthesizedTypeNode(type) ? type.type : type;
  return ts.isUnionTypeNode(inner) ? inner.types : undefined;
}

function put(out: Map<string, string>, key: string, text: string): void {
  if (out.has(key)) throw new Error(`снимок API: запись «${key}» объявлена дважды`);
  out.set(key, text);
}

/** Члены типа: вложенный литерал типа раскладывается на члены (`PluginContext.commands.run`), объединение - на варианты. */
function addMembers(out: Map<string, string>, prefix: string, members: ts.NodeArray<ts.TypeElement>, sf: ts.SourceFile): void {
  const methods = new Map<string, string[]>();
  for (const member of members) {
    const flags = `${has(member, ts.SyntaxKind.ReadonlyKeyword) ? 'readonly ' : ''}${'questionToken' in member && member.questionToken ? 'optional ' : ''}`;
    if (ts.isPropertySignature(member)) {
      const key = `member ${prefix}.${memberName(member.name, sf)}`;
      const type = member.type;
      if (!type) put(out, key, `${flags}prop any`);
      else if (ts.isTypeLiteralNode(type)) {
        put(out, key, `${flags}object`);
        addMembers(out, `${prefix}.${memberName(member.name, sf)}`, type.members, sf);
      } else if (ts.isFunctionTypeNode(type)) put(out, key, `${flags}fn ${signature(type, sf)}`);
      else {
        const variants = unionOf(type);
        if (variants) {
          put(out, key, `${flags}union`);
          for (const v of variants) put(out, `variant ${prefix}.${memberName(member.name, sf)} | ${print(v, sf)}`, '');
        } else put(out, key, `${flags}prop ${print(type, sf)}`);
      }
    } else if (ts.isMethodSignature(member)) {
      const name = memberName(member.name, sf);
      methods.set(name, [...(methods.get(name) ?? []), `${flags}method ${signature(member, sf)}`]);
    } else {
      // Вызов, конструктор, индексная подпись: ключ по роду, текст целиком.
      put(out, `member ${prefix}.[${ts.SyntaxKind[member.kind]}]${String(out.size)}`, print(member, sf));
    }
  }
  for (const [name, overloads] of methods) put(out, `member ${prefix}.${name}`, overloads.sort().join(' || '));
}

/** Экспортируемые интерфейсы и алиасы файла; `only` ограничивает состав и требует, чтобы каждое имя нашлось. */
export function declarationsOf(text: string, file: string, only?: readonly string[]): Map<string, string> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = new Map<string, string>();
  const found = new Set<string>();
  for (const node of sf.statements) {
    if (!(ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) || !has(node, ts.SyntaxKind.ExportKeyword)) continue;
    const name = node.name.text;
    if (only && !only.includes(name)) continue;
    found.add(name);
    if (ts.isInterfaceDeclaration(node)) {
      const heritage = (node.heritageClauses ?? []).flatMap((c) => c.types.map((t) => print(t, sf))).sort();
      put(out, `interface ${name}`, norm(`${typeParams(node, sf)}${heritage.length > 0 ? ` extends ${heritage.join(', ')}` : ''}`));
      addMembers(out, name, node.members, sf);
    } else {
      const variants = unionOf(node.type);
      if (variants) {
        put(out, `alias ${name}`, `${typeParams(node, sf)} union`.trim());
        for (const v of variants) put(out, `variant ${name} | ${print(v, sf)}`, '');
      } else put(out, `alias ${name}`, norm(`${typeParams(node, sf)} = ${print(node.type, sf)}`));
    }
  }
  for (const name of only ?? []) if (!found.has(name)) throw new Error(`снимок API: в ${file} нет экспортируемого объявления ${name}; переименовали или убрали - обновите состав в core/scripts/api-surface.ts`);
  return out;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

function constInitializer(sf: ts.SourceFile, name: string, file: string): ts.Expression {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return unwrap(d.initializer);
  }
  throw new Error(`снимок API: в ${file} нет константы ${name}; переименовали или убрали - обновите состав в core/scripts/api-surface.ts`);
}

function stringItems(expr: ts.Expression, what: string): string[] {
  const list = ts.isNewExpression(expr) && expr.arguments?.[0] ? unwrap(expr.arguments[0]) : expr;
  if (!ts.isArrayLiteralExpression(list)) throw new Error(`снимок API: ${what} - не массив и не new Set([...]) из строк`);
  return list.elements.map((e) => {
    const item = unwrap(e);
    if (!ts.isStringLiteralLike(item)) throw new Error(`снимок API: ${what} содержит не строку`);
    return item.text;
  });
}

export function constsOf(text: string, spec: ConstSource): Map<string, string> {
  const sf = ts.createSourceFile(spec.file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const init = constInitializer(sf, spec.name, spec.file);
  const out = new Map<string, string>();
  if (spec.kind === 'set') {
    for (const item of stringItems(init, `${spec.file}: ${spec.name}`)) put(out, `set ${spec.name} | ${item}`, '');
    return out;
  }
  if (!ts.isObjectLiteralExpression(init)) throw new Error(`снимок API: ${spec.file}: ${spec.name} - не объект`);
  for (const prop of init.properties) {
    if (!ts.isPropertyAssignment(prop)) throw new Error(`снимок API: ${spec.file}: ${spec.name} содержит не пару ключ: значение`);
    const value = unwrap(prop.initializer);
    if (!ts.isStringLiteralLike(value)) throw new Error(`снимок API: ${spec.file}: ${spec.name}.${memberName(prop.name, sf)} - не строка`);
    put(out, `map ${spec.name} | ${memberName(prop.name, sf)}`, value.text);
  }
  return out;
}

/** Теги из таблицы `ELEMENTS` и наблюдаемые атрибуты каждого с учётом наследования классов. */
export function elementsOf(text: string, file = ELEMENTS_FILE): Map<string, string> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const table = constInitializer(sf, 'ELEMENTS', file);
  if (!ts.isObjectLiteralExpression(table)) throw new Error(`снимок API: ${file}: ELEMENTS - не объект`);
  const classes = new Map<string, { parent?: string; attrs?: string[] }>();
  for (const node of sf.statements) {
    if (!ts.isClassDeclaration(node) || !node.name) continue;
    const parent = node.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    const entry: { parent?: string; attrs?: string[] } = {};
    if (parent && ts.isIdentifier(parent)) entry.parent = parent.text;
    for (const m of node.members) {
      if (ts.isPropertyDeclaration(m) && has(m, ts.SyntaxKind.StaticKeyword) && memberName(m.name, sf) === 'observedAttributes' && m.initializer) entry.attrs = stringItems(unwrap(m.initializer), `${file}: ${node.name.text}.observedAttributes`);
    }
    classes.set(node.name.text, entry);
  }
  const out = new Map<string, string>();
  for (const prop of table.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.initializer)) throw new Error(`снимок API: ${file}: ELEMENTS содержит не пару тег: класс`);
    const tag = memberName(prop.name, sf);
    put(out, `set element-tags | ${tag}`, '');
    let cls: string | undefined = prop.initializer.text;
    let attrs: string[] = [];
    for (let seen = 0; cls && seen < 16; seen++) {
      const entry = classes.get(cls);
      if (!entry) throw new Error(`снимок API: ${file}: класс ${cls} элемента ${tag} не найден`);
      if (entry.attrs) {
        attrs = entry.attrs;
        break;
      }
      cls = entry.parent;
    }
    for (const attr of attrs) put(out, `set attributes ${tag} | ${attr}`, '');
  }
  return out;
}

export type ReadFile = (relativePath: string) => string;

const readFromRepo: ReadFile = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');

/** Вся поверхность API плагина по исходникам; `read` подменяют тесты, чтобы показать порчу без правки файлов. */
export function extractSurface(read: ReadFile = readFromRepo): Surface {
  const out = new Map<string, string>();
  const add = (part: Map<string, string>): void => {
    for (const [k, v] of part) put(out, k, v);
  };
  for (const src of TYPE_SOURCES) add(declarationsOf(read(src.file), src.file, src.only));
  for (const spec of CONST_SOURCES) add(constsOf(read(spec.file), spec));
  add(elementsOf(read(ELEMENTS_FILE)));
  return out;
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function renderSurface(version: string, surface: Surface): string {
  const lines = [...surface.keys()].sort(byKey).map((k) => {
    const text = surface.get(k) ?? '';
    return text === '' ? k : `${k}${SEP}${text}`;
  });
  return `// plugin API ${version}\n${NOTE}${lines.join('\n')}\n`;
}

export function parseSurface(text: string): { readonly version: string; readonly surface: Surface } {
  const match = HEADER.exec(text);
  if (!match?.[1]) throw new Error('в эталоне нет строки-заголовка «// plugin API <версия>»');
  const surface = new Map<string, string>();
  for (const line of text.slice(match[0].length).split('\n')) {
    if (line === '' || line.startsWith('//')) continue;
    const at = line.indexOf(SEP);
    const key = at < 0 ? line : line.slice(0, at);
    if (surface.has(key)) throw new Error(`в эталоне запись «${key}» повторена`);
    surface.set(key, at < 0 ? '' : line.slice(at + SEP.length));
  }
  return { version: match[1], surface };
}

export interface Change {
  readonly kind: 'removed' | 'changed' | 'added';
  readonly key: string;
  /** Ломающее в пределах мажорной версии: удаление, смена типа, новый обязательный член у типа, который плагин строит или реализует. */
  readonly breaking: boolean;
  readonly why: string;
}

const isRequired = (text: string): boolean => !/^(readonly )?optional /.test(text);
const ownerOf = (key: string): string => key.slice('member '.length).split('.')[0] ?? '';

/** Что изменилось между эталоном и текущей поверхностью и какого рода каждое изменение. */
export function compareSurfaces(etalon: Surface, now: Surface): Change[] {
  const changes: Change[] = [];
  for (const [key, was] of etalon) {
    const is = now.get(key);
    if (is === undefined) changes.push({ kind: 'removed', key, breaking: true, why: 'удалено или переименовано' });
    else if (is !== was) changes.push({ kind: 'changed', key, breaking: true, why: `было «${was}», стало «${is}»` });
  }
  for (const [key, text] of now) {
    if (etalon.has(key)) continue;
    const owner = key.startsWith('member ') ? ownerOf(key) : '';
    const grown = owner !== '' && etalon.has(`interface ${owner}`);
    if (key.startsWith('member ') && grown && isRequired(text) && !KERNEL_SIDE.has(owner)) {
      changes.push({ kind: 'added', key, breaking: true, why: `новый обязательный член у ${owner}: плагин, собранный под прежний API, его не даёт` });
    } else changes.push({ kind: 'added', key, breaking: false, why: key.startsWith('member ') && isRequired(text) ? 'добавлено (ядро создаёт такой объект и отдаёт плагину)' : 'добавлено' });
  }
  return changes.sort((a, b) => byKey(a.key, b.key));
}

const describeChange = (c: Change): string => `  - ${c.breaking ? 'ломающее' : 'добавление'}: ${c.key}: ${c.why}`;

/** Кандидат в выпуск (`1.0.0-rc.1`): форма API заморожена для выпуска, изменение допустимо только новым кандидатом (K-21). */
export const candidateOf = (version: string): { readonly next: string } | undefined => {
  const match = /^(.*-rc\.)(\d+)$/.exec(version);
  return match?.[1] === undefined || match[2] === undefined ? undefined : { next: `${match[1]}${String(Number(match[2]) + 1)}` };
};

/** Линия разработки ещё не выпущенного пакета (`1.0.0-dev`, как в P-01): любой суффикс, кроме `-rc.N`. */
export const isPrerelease = (version: string): boolean => version.includes('-') && candidateOf(version) === undefined;

function parts(version: string): [number, number, number] {
  const [a = 0, b = 0, c = 0] = (version.split(/[-+]/)[0] ?? '').split('.').map(Number);
  return [a, b, c];
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export interface CheckInput {
  /** `PLUGIN_API_VERSION`. */
  readonly apiVersion: string;
  /** Версия пакета контрактов: суффикс `-dev` - линия разработки, `-rc.N` - кандидат, без суффикса - выпуск после заморозки. */
  readonly packageVersion: string;
  readonly surface: Surface;
  /** Тексты эталонов по версии из имени файла. */
  readonly etalons: ReadonlyMap<string, string>;
}

const major = (version: string): number => parts(version)[0];
const nextMinor = (version: string): string => `${String(major(version))}.${String(parts(version)[1] + 1)}.0`;

/** Ошибки проверки: эталон версии API против поверхности и цепочка эталонов одной мажорной версии друг против друга. */
export function checkSurface(input: CheckInput): string[] {
  const { apiVersion, packageVersion, surface, etalons } = input;
  const problems: string[] = [];
  const dev = isPrerelease(packageVersion);
  const candidate = candidateOf(packageVersion);
  const parsed = new Map<string, Surface>();
  for (const [version, text] of etalons) {
    try {
      const etalon = parseSurface(text);
      if (etalon.version !== version) problems.push(`эталон ${version}.txt: в заголовке версия ${etalon.version}, а в имени файла ${version}`);
      parsed.set(version, etalon.surface);
    } catch (error) {
      problems.push(`эталон ${version}.txt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const versions = [...parsed.keys()].sort(compareVersions);
  for (const v of versions) if (compareVersions(v, apiVersion) > 0) problems.push(`эталон ${v}.txt новее PLUGIN_API_VERSION ${apiVersion}: версию API повышают тем же PR, что создаёт эталон`);

  const own = parsed.get(apiVersion);
  const earlier = versions.filter((v) => major(v) === major(apiVersion) && compareVersions(v, apiVersion) < 0).pop();
  if (!own) {
    const base = earlier ? parsed.get(earlier) : undefined;
    const changes = base ? compareSurfaces(base, surface) : [];
    const hint = base && changes.some((c) => c.breaking) ? ` Поверхность ломает ${earlier ?? ''}, а мажорная версия та же:\n${changes.filter((c) => c.breaking).map(describeChange).join('\n')}\n` : '';
    problems.push(`нет эталона для версии API ${apiVersion}: создайте core/test/api-snapshot/${apiVersion}.txt командой npm run snapshot:api.${hint}`);
  } else {
    const changes = compareSurfaces(own, surface);
    if (changes.length > 0) {
      const list = changes.map(describeChange).join('\n');
      if (candidate) {
        problems.push(`публичный API плагина изменён, а эталон ${apiVersion}.txt принят как кандидат ${packageVersion}:\n${list}\nДо выпуска ${apiVersion} это допустимо только новым кандидатом: поднимите версию в contracts/package.json до ${candidate.next}, затем npm run snapshot:api и npm run snapshot:contracts, строка в contracts/CHANGELOG.md. После выпуска ${apiVersion} ломающее потребует мажорной версии ${String(major(apiVersion) + 1)}.0.0, добавление - ${nextMinor(apiVersion)}.`);
      } else if (dev) {
        problems.push(`публичный API плагина изменён, а эталон ${apiVersion}.txt - нет (пакет контрактов ${packageVersion} - линия разработки, версия API не повышается):\n${list}\nЕсли изменение задумано: npm run snapshot:api, строка в contracts/CHANGELOG.md. Ломающее после заморозки (K-21) потребует новой мажорной версии, добавление - минорной.`);
      } else if (changes.some((c) => c.breaking)) {
        problems.push(`ломающее изменение публичного API плагина в пределах мажорной версии ${String(major(apiVersion))} (эталон ${apiVersion}.txt):\n${list}\nВерните изменение. Если оно задумано, повысьте мажорную версию: PLUGIN_API_VERSION в core/src/api-version.ts и version в contracts/package.json до ${String(major(apiVersion) + 1)}.0.0, затем npm run snapshot:api (создаст эталон ${String(major(apiVersion) + 1)}.0.0.txt) и запись в contracts/CHANGELOG.md; согласует владелец API (contracts/README.md).`);
      } else {
        problems.push(`публичный API плагина дополнен, а версия API и эталон - нет (эталон ${apiVersion}.txt):\n${list}\nДобавление необязательного члена - минорная версия: поднимите PLUGIN_API_VERSION в core/src/api-version.ts и version в contracts/package.json до ${nextMinor(apiVersion)}, затем npm run snapshot:api (создаст эталон ${nextMinor(apiVersion)}.txt) и запись в contracts/CHANGELOG.md.`);
      }
    }
  }

  // Эталон новой версии нельзя «подогнать» под поломку: в пределах мажорной версии каждый следующий эталон только дополняет предыдущий.
  for (let i = 1; i < versions.length; i++) {
    const [prev, next] = [versions[i - 1], versions[i]];
    if (prev === undefined || next === undefined || major(prev) !== major(next)) continue;
    const base = parsed.get(prev);
    const after = parsed.get(next);
    if (!base || !after) continue;
    const breaking = compareSurfaces(base, after).filter((c) => c.breaking);
    if (breaking.length > 0) problems.push(`эталон ${next}.txt ломает ${prev}.txt при той же мажорной версии ${String(major(next))}:\n${breaking.map(describeChange).join('\n')}`);
  }
  return problems;
}

export function readEtalons(dir = ETALON_DIR): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.txt'))) out.set(file.slice(0, -'.txt'.length), fs.readFileSync(path.join(dir, file), 'utf8'));
  return out;
}

export function currentApiVersion(): string {
  const text = fs.readFileSync(path.join(repo, 'core/src/api-version.ts'), 'utf8');
  const match = /PLUGIN_API_VERSION\s*=\s*'([^']+)'/.exec(text);
  if (!match?.[1]) throw new Error('в core/src/api-version.ts не найден PLUGIN_API_VERSION');
  return match[1];
}

export function packageVersion(): string {
  return (JSON.parse(fs.readFileSync(path.join(repo, 'contracts/package.json'), 'utf8')) as { version: string }).version;
}

// `node core/scripts/api-surface.ts` - проверка; `--update` - записать эталон текущей версии API по исходникам.
if (process.argv[1] === import.meta.filename) {
  const version = currentApiVersion();
  const surface = extractSurface();
  if (process.argv.includes('--update')) {
    fs.mkdirSync(ETALON_DIR, { recursive: true });
    fs.writeFileSync(path.join(ETALON_DIR, `${version}.txt`), renderSurface(version, surface));
    process.stdout.write(`эталон core/test/api-snapshot/${version}.txt обновлён (${String(surface.size)} записей)\n`);
  } else {
    const problems = checkSurface({ apiVersion: version, packageVersion: packageVersion(), surface, etalons: readEtalons() });
    process.stderr.write(problems.map((p) => `ошибка: ${p}\n`).join(''));
    process.stdout.write(problems.length === 0 ? `публичный API плагина совпадает с эталоном ${version}\n` : '');
    process.exitCode = problems.length === 0 ? 0 : 1;
  }
}

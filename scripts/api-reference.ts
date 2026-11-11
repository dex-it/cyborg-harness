import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as TS from 'typescript';

// `node scripts/api-reference.ts [--write | --check]` - справочник ctx.* и UiContext из TSDoc (P-04, #38). Без флага и с `--write` файл пишется, с `--check` сверяется:
// устарел или не найден - код 1 (CI-шаг, `npm test`, сборка сайта). Разбор синтаксический, типы не проверяются; из `typescript` берётся только парсер.
// Член без описания в справочник попадает пометкой и ловится тестом (`missingDocs`): описание пишется в TSDoc контрактов, а не в страницу.

const REPO = path.resolve(import.meta.dirname, '..');

/** Файлы, из которых собирается справочник; порядок - порядок разделов. */
export const SOURCES: readonly string[] = ['contracts/plugin.ts', 'contracts/view.ts', 'contracts/os.ts'];
/** Страница справочника на сайте. */
export const OUTPUT = 'docs/guide/reference/ctx-api.md';

const UPDATE = 'npm run docs:api';

/** Корневые типы файла: идут первыми в своём разделе, остальное - в порядке исходника. */
const ENTRY: Readonly<Record<string, readonly string[]>> = {
  'contracts/plugin.ts': ['PluginModule', 'PluginContext'],
  'contracts/view.ts': ['UiModule', 'UiContext'],
  'contracts/os.ts': ['PluginOs', 'PluginPermissions'],
};
const SECTION_TITLES: Readonly<Record<string, string>> = {
  'contracts/plugin.ts': 'Главная часть: PluginModule и ctx',
  'contracts/view.ts': 'Вид: UiModule и ctx вида',
  'contracts/os.ts': 'Доступ к ОС: ctx.os и права',
};
/** Приставка в записи члена: `ctx.commands.register` у корневых типов, имя типа без приставки у остальных. */
const PREFIX: Readonly<Record<string, string>> = { PluginContext: 'ctx.', UiContext: 'ctx.' };

export interface Source {
  readonly file: string;
  readonly text: string;
}

export interface Member {
  /** Путь внутри типа: `commands.register`. */
  readonly path: string;
  /** Имя члена без пути: `register`; подпись начинается с него. */
  readonly name: string;
  /** Подпись как в исходнике, без `readonly` и без точки с запятой. */
  readonly signature: string;
  readonly doc: string;
  /** Имя типа из справочника, если тип члена - он. */
  readonly typeName?: string;
}

export interface Decl {
  readonly name: string;
  readonly kind: 'interface' | 'type';
  readonly file: string;
  readonly doc: string;
  readonly members: readonly Member[];
  /** Для алиаса, не раскрытого в члены: правая часть. */
  readonly text?: string;
  /** Для интерфейса: `extends ...`. */
  readonly extendsText?: string;
}

function loadTypeScript(): typeof TS {
  // Сначала рядом со скриптом (корень репозитория), затем от каталога запуска: сайт собирается с `typescript` из site/node_modules.
  for (const base of [import.meta.url, pathToFileURL(path.join(process.cwd(), 'package.json')).href]) {
    try {
      return createRequire(base)('typescript') as typeof TS;
    } catch {
      // следующий каталог
    }
  }
  throw new Error('пакет typescript не найден ни рядом со скриптом, ни в каталоге запуска: выполните npm ci');
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function collect(sources: readonly Source[]): Decl[] {
  const ts = loadTypeScript();
  const out: Decl[] = [];
  const parsed = sources.map((source) => ({ source, sf: ts.createSourceFile(source.file, source.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) }));
  // Имена всех типов справочника: ссылка на тип из соседнего файла (`ctx.os: PluginOs`) тоже ведёт на его раздел.
  const names = new Set<string>();
  for (const { sf } of parsed) for (const st of sf.statements) if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) names.add(st.name.text);
  for (const { source, sf } of parsed) {
    const docOf = (node: TS.Node): string => {
      const ranges = (ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? []).filter((r) => source.text.startsWith('/**', r.pos));
      const last = ranges[ranges.length - 1];
      if (!last) return '';
      const body = source.text.slice(last.pos + 3, last.end - 2);
      return squash(body.split('\n').map((line) => line.replace(/^\s*\*?/, '')).join(' '));
    };
    const nameOf = (m: TS.TypeElement): string | undefined => (m.name ? m.name.getText(sf) : undefined);
    const members = (list: readonly TS.TypeElement[], prefix: string): Member[] => {
      const res: Member[] = [];
      for (const m of list) {
        if (!ts.isPropertySignature(m) && !ts.isMethodSignature(m)) continue;
        const name = nameOf(m);
        if (name === undefined) continue;
        const full = prefix + name;
        const literal = ts.isPropertySignature(m) && m.type && ts.isTypeLiteralNode(m.type) ? m.type : undefined;
        const raw = squash(m.getText(sf)).replace(/;$/, '').replace(/^readonly /, '');
        const signature = literal ? `${raw.slice(0, raw.indexOf(':'))}: {...}` : raw;
        const typeText = ts.isPropertySignature(m) && m.type && !literal ? squash(m.type.getText(sf)).replace(/\s*\|\s*undefined$/, '') : undefined;
        res.push({ path: full, name, signature, doc: docOf(m), ...(typeText !== undefined && names.has(typeText) && { typeName: typeText }) });
        if (literal) res.push(...members(literal.members, `${full}.`));
      }
      return res;
    };

    for (const st of sf.statements) {
      if (ts.isInterfaceDeclaration(st)) {
        const heritage = st.heritageClauses?.map((h) => squash(h.getText(sf))).join(' ');
        out.push({ name: st.name.text, kind: 'interface', file: source.file, doc: docOf(st), members: members(st.members, ''), ...(heritage && { extendsText: heritage }) });
      } else if (ts.isTypeAliasDeclaration(st)) {
        const literal = ts.isTypeLiteralNode(st.type) ? st.type : undefined;
        out.push({
          name: st.name.text,
          kind: 'type',
          file: source.file,
          doc: docOf(st),
          members: literal ? members(literal.members, '') : [],
          ...(!literal && { text: squash(st.type.getText(sf)) }),
        });
      }
    }
  }
  return out;
}

/** Типы и члены без TSDoc: `Тип` и `Тип.член`. Пустой список - справочник полон. */
export function missingDocs(decls: readonly Decl[]): string[] {
  const out: string[] = [];
  for (const d of decls) {
    if (d.doc === '') out.push(d.name);
    for (const m of d.members) if (m.doc === '') out.push(`${d.name}.${m.path}`);
  }
  return out;
}

export interface Meta {
  readonly version: string;
  readonly date: string;
}

/** Угловая скобка вне кода открыла бы тег в Markdown: `<группа>` в прозе экранируется, код в обратных кавычках остаётся как есть. */
function prose(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replaceAll('<', '&lt;')))
    .join('');
}

const anchor = (name: string): string => name.toLowerCase();

export function render(decls: readonly Decl[], meta: Meta): string {
  const lines: string[] = [
    '---',
    'title: "Справочник ctx и UiContext"',
    'description: "Все члены ctx главной части, ctx вида и ctx.os: подписи и описания, собранные из TSDoc пакета контрактов."',
    '---',
    '',
    `:::note[Страница сгенерирована]`,
    `Версия API: ${meta.version}. Дата: ${meta.date} (запись версии в \`contracts/CHANGELOG.md\`). Источник - TSDoc файлов ${SOURCES.map((f) => `\`${f}\``).join(', ')}; правьте описания там, а страницу пересоберите командой \`${UPDATE}\`. CI падает, если страница устарела. Правила стабильности членов - раздел «Что стабильно, а что нет» в [README пакета контрактов](https://github.com/dex-it/cyborg-harness/blob/master/contracts/README.md).`,
    ':::',
    '',
    'Справочник отвечает на вопрос «что делает этот член и что он принимает». Как ими пользоваться, написано в [главной части](/authors/main-api/), [виде](/authors/view-api/) и [рецептах](/authors/recipes/); права `ctx.os` - в [справочнике прав](/reference/permissions/).',
    '',
  ];
  for (const file of SOURCES) {
    const inFile = decls.filter((d) => d.file === file);
    if (inFile.length === 0) continue;
    const first = ENTRY[file] ?? [];
    const ordered = [...first.flatMap((n) => inFile.filter((d) => d.name === n)), ...inFile.filter((d) => !first.includes(d.name))];
    lines.push(`## ${SECTION_TITLES[file] ?? file}`, '', `Файл \`${file}\`.`, '');
    for (const d of ordered) {
      const prefix = PREFIX[d.name] ?? '';
      lines.push(`### ${d.name}`, '');
      lines.push(d.doc === '' ? '_Описания нет._' : prose(d.doc), '');
      if (d.extendsText) lines.push(`\`${d.extendsText}\``, '');
      if (d.text !== undefined) lines.push('```ts', `type ${d.name} = ${d.text};`, '```', '');
      for (const m of d.members) {
        const shown = `${prefix}${m.path}${m.signature.slice(m.name.length)}`;
        const link = m.typeName ? ` Тип: [${m.typeName}](#${anchor(m.typeName)}).` : '';
        lines.push(`- \`${shown}\` - ${m.doc === '' ? '_описания нет_' : prose(m.doc)}${link}`);
      }
      if (d.members.length > 0) lines.push('');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Версия пакета контрактов и дата её записи в журнале изменений; нет записи - так и сказано, а не выдуманная дата. */
export function readMeta(root: string): Meta {
  const version = (JSON.parse(fs.readFileSync(path.join(root, 'contracts/package.json'), 'utf8')) as { version: string }).version;
  const changelog = fs.readFileSync(path.join(root, 'contracts/CHANGELOG.md'), 'utf8');
  const found = changelog.split('\n').find((line) => line.startsWith(`## ${version} - `));
  return { version, date: found ? found.slice(`## ${version} - `.length).trim() : 'не выпущена (записи в CHANGELOG нет)' };
}

export function generate(root: string = REPO): string {
  const decls = collect(SOURCES.map((file) => ({ file, text: fs.readFileSync(path.join(root, file), 'utf8') })));
  return render(decls, readMeta(root));
}

export interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export function main(args: readonly string[], options: { readonly root?: string } = {}): Result {
  const root = options.root ?? REPO;
  for (const arg of args) if (arg !== '--write' && arg !== '--check') throw new Error(`неизвестный аргумент ${arg}: допустимы --write и --check`);
  const target = path.join(root, OUTPUT);
  const text = generate(root);
  if (args.includes('--check')) {
    if (!fs.existsSync(target)) return { code: 1, out: '', err: `ошибка: ${OUTPUT} не найден: выполните ${UPDATE}\n` };
    if (fs.readFileSync(target, 'utf8') !== text) return { code: 1, out: '', err: `ошибка: ${OUTPUT} устарел относительно TSDoc контрактов: выполните ${UPDATE} и закоммитьте результат\n` };
    return { code: 0, out: `${OUTPUT} совпадает с TSDoc контрактов\n`, err: '' };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return { code: 0, out: `${OUTPUT} записан\n`, err: '' };
}

if (process.argv[1] === import.meta.filename) {
  const result = main(process.argv.slice(2));
  process.stdout.write(result.out);
  process.stderr.write(result.err);
  process.exitCode = result.code;
}

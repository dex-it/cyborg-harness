import fs from 'node:fs';
import path from 'node:path';

// `node scripts/check-docs-links.ts [путь...]` - проверка относительных ссылок и якорей в Markdown (P-10, CI-шаг «ссылки в docs»).
// Без сторонних сервисов и без сети: внешние адреса (`https:`, `mailto:`) и абсолютные пути сайта (`/development/...`) не проверяются -
// первые живут вне репозитория, вторые проверяет `site/ npm run verify`. Путь, регистр имени файла и якорь заголовка сверяются с деревом.

export interface LinkProblem {
  /** Файл со ссылкой, путь от корня проверки. */
  readonly file: string;
  readonly line: number;
  /** Ссылка так, как она записана в тексте. */
  readonly link: string;
  readonly reason: string;
}

export interface LinkReport {
  readonly files: number;
  readonly links: number;
  readonly problems: readonly LinkProblem[];
}

export interface FoundLink {
  readonly line: number;
  readonly target: string;
}

const MARKDOWN = /\.mdx?$/;
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist']);

/** Якорь заголовка по правилам GitHub и github-slugger (его берёт и Starlight): нижний регистр, без знаков препинания, пробелы в дефисы. */
export function slugify(heading: string): string {
  // Теги HTML вне строчного кода - разметка и в текст не входят; внутри кода `<iframe>` остаётся текстом.
  const plain = heading
    .split(/(`+[^`]*`+)/)
    .map((part) => (part.startsWith('`') ? part : part.replace(/<[^>]*>/g, '')))
    .join('')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*~]/g, '')
    .replace(/(^|\s)_+|_+(\s|$)/g, '$1$2')
    .trim()
    .toLowerCase();
  return plain.replace(/[^\p{L}\p{N}\p{M} _-]/gu, '').replace(/ /g, '-');
}

/** Строки текста вне блоков кода (``` и ~~~): номер строки с 1 и сама строка. */
function proseLines(markdown: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let fence: string | undefined;
  markdown.split('\n').forEach((text, index) => {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (fence === undefined) {
      if (open?.[1]) fence = open[1];
      else out.push({ line: index + 1, text });
    } else if (open?.[1] && open[1].startsWith(fence.charAt(0)) && open[1].length >= fence.length && /^\s{0,3}[`~]+\s*$/.test(text)) {
      fence = undefined;
    }
  });
  return out;
}

/** Якоря файла: заголовки ATX (с суффиксом `-1`, `-2` у повторов), `id` и `name` в HTML. Шапка front matter заголовков не даёт. */
export function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, (head) => '\n'.repeat(head.split('\n').length - 1));
  for (const { text } of proseLines(body)) {
    const heading = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(text);
    if (heading?.[1]) {
      const custom = /\s*\{#([^}\s]+)\}\s*$/.exec(heading[1]);
      const slug = custom?.[1] ?? slugify(heading[1]);
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      anchors.add(count === 0 ? slug : `${slug}-${String(count)}`);
    }
    for (const html of text.matchAll(/<[a-z][^>]*?\s(?:id|name)=["']([^"']+)["']/gi)) if (html[1]) anchors.add(html[1]);
  }
  return anchors;
}

/** Ссылки текста: `[текст](адрес "подпись")`, изображения, `[метка]: адрес` и `href`/`src` в HTML. Код (блоки и строчный) пропускается. */
export function extractLinks(markdown: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const { line, text } of proseLines(markdown)) {
    const bare = text.replace(/(`+)[^`]*?\1/g, (span) => ' '.repeat(span.length));
    for (const m of bare.matchAll(/\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) if (m[1] !== undefined) found.push({ line, target: m[1].replace(/^<|>$/g, '') });
    const reference = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(bare);
    if (reference?.[1]) found.push({ line, target: reference[1].replace(/^<|>$/g, '') });
    for (const m of bare.matchAll(/<[a-z][^>]*?\s(?:href|src)=["']([^"']*)["']/gi)) if (m[1] !== undefined) found.push({ line, target: m[1] });
  }
  return found;
}

function markdownFiles(start: string): string[] {
  const stat = fs.statSync(start);
  if (stat.isFile()) return MARKDOWN.test(start) ? [start] : [];
  return fs
    .readdirSync(start, { withFileTypes: true })
    .filter((e) => !SKIPPED_DIRS.has(e.name))
    .flatMap((e) => markdownFiles(path.join(start, e.name)))
    .sort();
}

/** Есть ли путь на диске с точным регистром каждого имени: на macOS ссылка с другим регистром работает, на Linux и в GitHub - нет. */
function existsExactly(target: string, listings: Map<string, Set<string>>): boolean {
  const parts = path.resolve(target).split(path.sep);
  let current = parts[0] === '' ? path.sep : (parts[0] ?? '');
  for (const part of parts.slice(1)) {
    if (part === '') continue;
    let names = listings.get(current);
    if (!names) {
      try {
        names = new Set(fs.readdirSync(current));
      } catch {
        return false;
      }
      listings.set(current, names);
    }
    if (!names.has(part)) return false;
    current = path.join(current, part);
  }
  return true;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Проверяет Markdown-файлы под `paths` (файлы или каталоги, от `root`): относительный путь существует, якорь есть среди заголовков файла-цели. */
export function checkLinks(root: string, paths: readonly string[]): LinkReport {
  const files = paths.flatMap((p) => markdownFiles(path.resolve(root, p)));
  const listings = new Map<string, Set<string>>();
  const anchorsOf = new Map<string, Set<string>>();
  const anchors = (file: string): Set<string> => {
    let set = anchorsOf.get(file);
    if (!set) {
      set = headingAnchors(fs.readFileSync(file, 'utf8'));
      anchorsOf.set(file, set);
    }
    return set;
  };
  const problems: LinkProblem[] = [];
  let links = 0;
  for (const file of files) {
    for (const { line, target } of extractLinks(fs.readFileSync(file, 'utf8'))) {
      if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('/')) continue;
      links++;
      const hash = target.indexOf('#');
      const rawPath = (hash === -1 ? target : target.slice(0, hash)).replace(/\?.*$/, '');
      const anchor = hash === -1 ? '' : decode(target.slice(hash + 1));
      const resolved = rawPath === '' ? file : path.resolve(path.dirname(file), decode(rawPath));
      const report = (reason: string): void => {
        problems.push({ file: path.relative(root, file), line, link: target, reason });
      };
      if (!existsExactly(resolved, listings)) {
        report(`нет такого пути: ${path.relative(root, resolved)}`);
        continue;
      }
      if (anchor === '' || !MARKDOWN.test(resolved) || !fs.statSync(resolved).isFile()) continue;
      if (!anchors(resolved).has(anchor)) report(`в ${path.relative(root, resolved)} нет якоря #${anchor}`);
    }
  }
  return { files: files.length, links, problems };
}

/** Разбор командной строки и печать отчёта; код выхода 1, если есть битые ссылки. */
export function main(args: readonly string[], root: string): { code: number; out: string; err: string } {
  const report = checkLinks(root, args.length > 0 ? args : ['docs']);
  if (report.problems.length === 0) return { code: 0, out: `ссылки в порядке: файлов ${String(report.files)}, относительных ссылок ${String(report.links)}\n`, err: '' };
  const lines = report.problems.map((p) => `${p.file}:${String(p.line)}: [${p.link}] ${p.reason}`);
  return { code: 1, out: '', err: `битых ссылок: ${String(report.problems.length)} из ${String(report.links)} (файлов ${String(report.files)})\n${lines.join('\n')}\n` };
}

if (process.argv[1] === import.meta.filename) {
  const result = main(process.argv.slice(2), process.cwd());
  process.stdout.write(result.out);
  process.stderr.write(result.err);
  process.exitCode = result.code;
}

// Разбор импортов и верхнего уровня файла без компилятора: правило «плагин импортирует только @cyborg-harness/contracts и свои модули» должно работать у автора вне репозитория, а в ядре нет npm-зависимостей (T-04).
// Это не парсер языка: лексер (комментарии, строки, шаблоны, регулярные выражения) и разбор нескольких форм по токенам. Всё, что не разобралось, даёт нарушение, а не молчание.

/** Вместо пути стоит выражение: статика не видит, что загрузится. */
export const COMPUTED = '<вычисляемый путь>';
/** Оператор `import` не разобрался: файл с ошибкой синтаксиса не должен проходить проверку молча. */
export const UNREADABLE = '<оператор не разобран>';

export interface Use {
  readonly spec: string;
  readonly typeOnly: boolean;
  readonly line: number;
}

type Kind = 'id' | 'str' | 'tpl' | 'tpl-end' | 'num' | 're' | 'p';

interface Token {
  readonly kind: Kind;
  /** Идентификатор или знак; у строки - значение после разбора escape-последовательностей. */
  readonly text: string;
  readonly line: number;
  /** Перед токеном был перевод строки: нужен, чтобы отличить конец оператора без `;`. */
  readonly nl: boolean;
}

const ID_START = /[\p{ID_Start}$_]/u;
const ID_PART = /[\p{ID_Continue}$‌‍]/u;
const DIGIT = /[0-9]/;
// После этих слов `/` начинает регулярное выражение, после остальных идентификаторов - деление.
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
// Скобка после этих слов - заголовок оператора: `if (a) /x/.test(b)`, слеш после `)` начинает регулярное выражение.
const HEADER_WORDS = new Set(['if', 'while', 'for', 'with']);
// Слова перед `{`, после которых это объект или значение, а не блок: `return {}`, `typeof {}`. Остальные слова (имя класса, `try`, `finally`, `else`, `do`) открывают блок.
const VALUE_BEFORE_BRACE = new Set([...REGEX_AFTER].filter((w) => w !== 'do' && w !== 'else'));
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };

const isLineBreak = (c: string | undefined) => c === '\n' || c === '\r' || c === ' ' || c === ' ';

/** Значение строкового литерала: `'n\x6fde:fs'` - это `node:fs`, и проверка должна видеть именно его. */
function cook(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charAt(i);
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    if (next === 'x' && /^[0-9a-fA-F]{2}/.test(raw.slice(i + 1, i + 3))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (next === 'u' && raw[i + 1] === '{') {
      const end = raw.indexOf('}', i);
      const code = end > 0 ? parseInt(raw.slice(i + 2, end), 16) : NaN;
      if (Number.isNaN(code) || code > 0x10ffff) out += next;
      else {
        out += String.fromCodePoint(code);
        i = end;
      }
    } else if (next === 'u' && /^[0-9a-fA-F]{4}/.test(raw.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (next === '\r') {
      if (raw[i + 1] === '\n') i++;
    } else if (next === '\n' || next === ' ' || next === ' ') {
      // продолжение строки
    } else {
      out += SIMPLE_ESCAPES[next] ?? next;
    }
  }
  return out;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let nl = false;
  // Глубина фигурных скобок и глубины, на которых открыты подстановки `${` шаблонов.
  let depth = 0;
  const templates: number[] = [];
  // Открытые скобки: у `(` - заголовок ли оператора, у `{` - блок ли. Закрывающая скобка с таким признаком оставляет слеш за ней регулярным выражением, а не делением.
  const parens: boolean[] = [];
  const braces: boolean[] = [];
  const regexAfterClose = new Set<number>();

  const newline = (at: number) => {
    if (text[at] === '\r' && text[at + 1] === '\n') return;
    line++;
  };
  const push = (kind: Kind, value: string, startLine: number) => {
    tokens.push({ kind, text: value, line: startLine, nl });
    nl = false;
  };
  const prevAllowsRegex = (): boolean => {
    const prev = tokens.at(-1);
    if (prev === undefined) return true;
    if (prev.kind === 'id') return REGEX_AFTER.has(prev.text);
    if (prev.kind === 'p') {
      if (prev.text === ')' || prev.text === '}') return regexAfterClose.has(tokens.length - 1);
      if (prev.text === ']') return false;
      // `i++ / 2`: после постфиксного `++` и `--` стоит деление.
      const before = tokens.at(-2);
      return !((prev.text === '+' || prev.text === '-') && before?.kind === 'p' && before.text === prev.text);
    }
    return false;
  };

  /** Слово перед `(` - заголовок оператора (`for await (` тоже). */
  const opensHeader = (): boolean => {
    const prev = tokens.at(-1);
    if (prev?.kind !== 'id') return false;
    return HEADER_WORDS.has(prev.text) || (prev.text === 'await' && tokens.at(-2)?.text === 'for');
  };
  /** `{` открывает блок (за `}` слеш - регулярное выражение), а не объект или тело выражения. После `)` это блок: тело оператора или функции. */
  const opensBlock = (): boolean => {
    const prev = tokens.at(-1);
    if (prev === undefined) return true;
    if (prev.kind === 'id') return !VALUE_BEFORE_BRACE.has(prev.text);
    if (prev.kind !== 'p') return false;
    return prev.text === ';' || prev.text === '{' || prev.text === '}' || prev.text === ')';
  };

  /** Читает шаблон с позиции после "`" или "}" подстановки до "`" или "${". */
  const template = (head: boolean, startLine: number) => {
    let raw = '';
    for (; i < text.length; i++) {
      const c = text.charAt(i);
      if (c === '\\') {
        raw += c + (text[i + 1] ?? '');
        if (isLineBreak(text[i + 1])) newline(i + 1);
        i++;
      } else if (c === '`') {
        i++;
        if (head) {
          push('str', cook(raw), startLine);
        } else push('tpl-end', '', line);
        return;
      } else if (c === '$' && text[i + 1] === '{') {
        i += 2;
        templates.push(depth);
        push('tpl', '', startLine);
        return;
      } else {
        raw += c;
        if (isLineBreak(c)) newline(i);
      }
    }
  };

  if (text.startsWith('#!')) while (i < text.length && !isLineBreak(text[i])) i++;

  while (i < text.length) {
    const c = text.charAt(i);
    if (isLineBreak(c)) {
      newline(i);
      nl = true;
      i++;
    } else if (c === ' ' || c === '\t' || c === '\v' || c === '\f' || c === ' ' || c === '﻿' || /\s/u.test(c)) {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && !isLineBreak(text[i])) i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) {
        if (isLineBreak(text[i])) {
          newline(i);
          nl = true;
        }
      }
    } else if (c === "'" || c === '"') {
      const startLine = line;
      let raw = '';
      i++;
      while (i < text.length && text[i] !== c && !isLineBreak(text[i])) {
        if (text[i] === '\\') {
          raw += text.charAt(i);
          i++;
          if (isLineBreak(text[i])) {
            raw += text.charAt(i);
            if (text[i] === '\r' && text[i + 1] === '\n') raw += text.charAt(++i);
            line++;
            i++;
            continue;
          }
        }
        raw += text[i] ?? '';
        i++;
      }
      if (text[i] === c) i++;
      push('str', cook(raw), startLine);
    } else if (c === '`') {
      i++;
      template(true, line);
    } else if (c === '{') {
      depth++;
      braces.push(opensBlock());
      push('p', c, line);
      i++;
    } else if (c === '}') {
      if (templates.length > 0 && templates.at(-1) === depth) {
        templates.pop();
        i++;
        const startLine = line;
        template(false, startLine);
      } else {
        depth = Math.max(0, depth - 1);
        const block = braces.pop() ?? false;
        push('p', c, line);
        if (block) regexAfterClose.add(tokens.length - 1);
        i++;
      }
    } else if (c === '/' && prevAllowsRegex()) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      for (; j < text.length && !isLineBreak(text[j]); j++) {
        const d = text.charAt(j);
        if (d === '\\') j++;
        else if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) {
          closed = true;
          break;
        }
      }
      if (closed) {
        j++;
        while (j < text.length && ID_PART.test(text.charAt(j))) j++;
        push('re', text.slice(i, j), line);
        i = j;
      } else {
        // Не регулярное выражение: знак деления.
        push('p', c, line);
        i++;
      }
    } else if (ID_START.test(c) || c === '\\') {
      let j = i + 1;
      while (j < text.length && (ID_PART.test(text.charAt(j)) || text[j] === '\\')) j++;
      push('id', text.slice(i, j), line);
      i = j;
    } else if (DIGIT.test(c) || (c === '.' && DIGIT.test(text[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < text.length && /[0-9A-Za-z_.]/.test(text.charAt(j))) j++;
      push('num', text.slice(i, j), line);
      i = j;
    } else {
      if (c === '(') parens.push(opensHeader());
      push('p', c, line);
      if (c === ')' && (parens.pop() ?? false)) regexAfterClose.add(tokens.length - 1);
      i++;
    }
  }
  return tokens;
}

/** Вместо токена за концом файла: ни один знак и ни одно слово с ним не совпадают. */
const EOF: Token = { kind: 'p', text: '\0', line: 0, nl: false };
const isP = (t: Token | undefined, text: string) => t?.kind === 'p' && t.text === text;
const isId = (t: Token | undefined, text?: string) => t?.kind === 'id' && (text === undefined || t.text === text);

/** Индекс закрывающей скобки для открывающей в `from`; -1, если не закрыта. */
function closing(tokens: readonly Token[], from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    if (isP(tokens[i], open)) depth++;
    else if (isP(tokens[i], close) && --depth === 0) return i;
  }
  return -1;
}

/** `type` перед клаузой - модификатор, а не имя импортируемого по умолчанию (в `import type from "x"` имя импорта - type). */
function typeModifier(t: readonly Token[], at: number): boolean {
  if (!isId(t[at], 'type')) return false;
  const next = t[at + 1];
  if (isP(next, '{') || isP(next, '*')) return true;
  return next?.kind === 'id' && (next.text !== 'from' || isId(t[at + 2], 'from'));
}

/** Элемент `{ type A }` помечен как тип; неоднозначное (`type as x`) считается значением: так нарушений больше, а не меньше. */
function elementTypeOnly(element: readonly Token[]): boolean {
  const second = element[1];
  return isId(element[0], 'type') && second !== undefined && (second.kind === 'str' || (second.kind === 'id' && second.text !== 'as'));
}

/** Все формы загрузки модуля: статический import и реэкспорт, вызовы import и require, import type, тип-импорт в позиции типа; вычисляемый путь и неразобранный оператор - отдельными записями. */
export function usesOf(text: string): Use[] {
  const t = tokenize(text);
  const uses: Use[] = [];
  const tk = (k: number): Token => t[k] ?? EOF;
  const add = (spec: string, typeOnly: boolean, line: number) => uses.push({ spec, typeOnly, line });

  /** `import(…)` и `require(…)`: строка одна и сразу закрывает скобку или идёт аргументом перед опциями; иначе путь вычисляется. */
  const call = (at: number, open: number, typeOnly: boolean) => {
    const arg = t[open + 1];
    if (arg === undefined || isP(arg, ')')) return;
    const after = t[open + 2];
    if (arg.kind === 'str' && (isP(after, ')') || isP(after, ','))) add(arg.text, typeOnly, tk(at).line);
    else add(COMPUTED, false, tk(at).line);
  };

  /** Возвращает индекс последнего токена оператора. */
  const importStatement = (at: number): number => {
    const line = tk(at).line;
    let j = at + 1;
    if (t[j]?.kind === 'str') {
      add(tk(j).text, false, line);
      return j;
    }
    const typeKw = typeModifier(t, j);
    if (typeKw) j++;
    let hasDefault = false;
    if (t[j]?.kind === 'id') {
      hasDefault = true;
      j++;
      if (isP(t[j], '=')) {
        j++;
        if (isId(t[j], 'require') && isP(t[j + 1], '(')) {
          call(j, j + 1, typeKw);
          return j + 1;
        }
        return j; // `import A = B.C`: псевдоним, модуль не загружается
      }
      if (isP(t[j], ',')) j++;
    }
    const elements: Token[][] = [];
    if (isP(t[j], '*')) {
      if (isId(t[j + 1], 'as') && t[j + 2]?.kind === 'id') j += 3;
      else {
        add(UNREADABLE, false, line);
        return at;
      }
    } else if (isP(t[j], '{')) {
      const end = closing(t, j, '{', '}');
      if (end < 0) {
        add(UNREADABLE, false, line);
        return at;
      }
      let current: Token[] = [];
      for (let k = j + 1; k < end; k++) {
        if (isP(t[k], ',')) {
          if (current.length > 0) elements.push(current);
          current = [];
        } else current.push(tk(k));
      }
      if (current.length > 0) elements.push(current);
      j = end + 1;
    } else if (!hasDefault) {
      add(UNREADABLE, false, line);
      return at;
    }
    if (isId(t[j], 'from') && t[j + 1]?.kind === 'str') {
      add(tk(j + 1).text, typeKw || (!hasDefault && elements.length > 0 && elements.every(elementTypeOnly)), line);
      return j + 1;
    }
    add(UNREADABLE, false, line);
    return at;
  };

  const exportStatement = (at: number): number => {
    let j = at + 1;
    const typeKw = isId(t[j], 'type') && (isP(t[j + 1], '{') || isP(t[j + 1], '*'));
    if (typeKw) j++;
    if (isP(t[j], '*')) {
      j++;
      if (isId(t[j], 'as')) j += 2;
    } else if (isP(t[j], '{')) {
      const end = closing(t, j, '{', '}');
      if (end < 0) return at;
      j = end + 1;
    } else return at;
    if (isId(t[j], 'from') && t[j + 1]?.kind === 'str') {
      add(tk(j + 1).text, typeKw, tk(at).line);
      return j + 1;
    }
    return at;
  };

  for (let i = 0; i < t.length; i++) {
    const tok = tk(i);
    if (tok.kind !== 'id' || isP(t[i - 1], '.')) continue;
    if (tok.text === 'import') {
      const next = t[i + 1];
      if (isP(next, '(')) call(i, i + 1, false);
      else if (next?.kind === 'str' || isP(next, '{') || isP(next, '*') || next?.kind === 'id') i = importStatement(i);
    } else if (tok.text === 'export') {
      i = exportStatement(i);
    } else if (tok.text === 'require' && isP(t[i + 1], '(')) {
      call(i, i + 1, false);
    }
  }
  return uses;
}

const START_WORDS = new Set(['export', 'import', 'declare', 'interface', 'type', 'const', 'let', 'var', 'function', 'class', 'enum', 'namespace', 'module', 'abstract', 'async']);
// Знак в конце строки: оператор не закончен, следующая строка его продолжает.
const OPEN_ENDS = new Set(['=', '|', '&', ',', '<', '(', '[', '{', ':', '?', '.', '+', '-', '*', '/']);
// Знак в начале строки продолжает предыдущую.
const CONTINUES = new Set(['|', '&', '.', '?', ':', '=', ',', '>', ')', ']', '}']);

/** Операторы верхнего уровня: каждый - список его токенов на глубине 0 и вложенных. */
function statements(t: readonly Token[]): Token[][] {
  const tk = (k: number): Token => t[k] ?? EOF;
  const out: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const tok = tk(i);
    const prev = t[i - 1];
    if (depth === 0 && current.length > 0 && prev !== undefined) {
      const ended = isP(prev, ';');
      const arrow = isP(prev, '>') && isP(t[i - 2], '=');
      const continues = (prev.kind === 'p' && OPEN_ENDS.has(prev.text)) || arrow || (tok.kind === 'p' && CONTINUES.has(tok.text)) || isId(tok, 'extends');
      const afterBlock = isP(prev, '}') && tok.kind === 'id' && START_WORDS.has(tok.text);
      if (ended || (tok.nl && !continues) || afterBlock) {
        out.push(current);
        current = [];
      }
    }
    current.push(tok);
    if (tok.kind === 'p') {
      if (tok.text === '{' || tok.text === '(' || tok.text === '[') depth++;
      else if (tok.text === '}' || tok.text === ')' || tok.text === ']') depth = Math.max(0, depth - 1);
    }
  }
  if (current.length > 0) out.push(current);
  return out.filter((s) => !(s.length === 1 && isP(s[0], ';')));
}

/** В пакете объявлений нет кода: иначе через него плагин получил бы общий модуль под видом типов. Возвращает номера строк операторов, где не только типы. */
export function declarationProblems(text: string, contracts: string): number[] {
  const found: number[] = [];
  for (const s of statements(tokenize(text))) {
    let k = 0;
    if (isId(s[k], 'export')) k++;
    if (isId(s[k], 'declare')) k++;
    const word = s[k];
    const name = s[k + 1];
    const ok =
      (isId(word, 'interface') && name?.kind === 'id') ||
      (isId(word, 'type') && name?.kind === 'id') ||
      (isId(word, 'module') && name?.kind === 'str' && name.text === contracts && isP(s[k + 2], '{')) ||
      (k === 0 && isId(word, 'import') && isId(name, 'type') && typeImportOf(s, contracts));
    if (!ok) found.push((s[0] ?? EOF).line);
  }
  return found;
}

/** Оператор - import type из пакета контрактов целиком, без других форм. */
function typeImportOf(s: readonly Token[], contracts: string): boolean {
  const from = s.findIndex((tok, i) => isId(tok, 'from') && s[i + 1]?.kind === 'str');
  return from > 0 && s[from + 1]?.text === contracts && !s.slice(2, from).some((tok) => isP(tok, '='));
}

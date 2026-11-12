import { normalizeKey } from './keys.ts';

// Строки в исходном JSON манифеста: `checkPlugin` печатает ошибки как «manifest.json:<строка>: <причина>» (FR-CH-7005).
// `JSON.parse` положения не хранит, а в ядре нет npm-зависимостей, поэтому текст разбирается здесь: строгий разбор по RFC 8259 без значений
// (кроме строк) только ради строк ключей. Годность документа по-прежнему решает `JSON.parse`; этот разбор должен с ним совпадать (core/test/manifest-lines.test.ts).

/** Узел JSON: где начинается значение и, если оно лежит в объекте, где написан его ключ. Номера строк - с 1. */
export interface JsonNode {
  /** Строка, где начинается значение (у объекта и массива - строка `{` и `[`). */
  readonly line: number;
  /** Строка ключа в объекте; у корня и элементов массива нет. */
  readonly keyLine?: number;
  /** Члены объекта; при одинаковых ключах - последний, как у `JSON.parse`. */
  readonly members?: ReadonlyMap<string, JsonNode>;
  readonly items?: readonly JsonNode[];
  /** Значение строки. */
  readonly text?: string;
}

/** Разбор текста: дерево положений или строка, на которой текст перестал быть JSON. */
export interface JsonLayout {
  readonly root?: JsonNode;
  readonly errorLine?: number;
}

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX4 = /[0-9a-fA-F]{4}/y;

class Stop extends Error {
  readonly offset: number;
  constructor(offset: number) {
    super('не JSON');
    this.offset = offset;
  }
}

/** Начала строк: перевод строки - `\n`, `\r\n` или одиночный `\r` (так считают редакторы), `\r\n` один раз. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a || (c === 0x0d && text.charCodeAt(i + 1) !== 0x0a)) starts.push(i + 1);
  }
  return starts;
}

/** Номер строки (с 1) символа со смещением `offset`. */
function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((starts[mid] ?? 0) <= offset) low = mid + 1;
    else high = mid;
  }
  return Math.max(low, 1);
}

/** Положения ключей в тексте JSON. Текст, который `JSON.parse` не принял, даёт `errorLine`: строку первого лишнего символа, а при обрыве - строку последнего значащего. */
export function layoutJson(text: string): JsonLayout {
  const starts = lineStarts(text);
  let pos = 0;
  const stop = (): never => {
    throw new Stop(pos);
  };
  const skip = (): void => {
    while (pos < text.length && WHITESPACE.has(text.charCodeAt(pos))) pos++;
  };
  const expect = (char: string): void => {
    if (text[pos] !== char) stop();
    pos++;
  };

  // Позиция на открывающей кавычке; возвращает значение строки.
  const string = (): string => {
    const from = pos;
    pos++;
    for (;;) {
      const c = text.charCodeAt(pos);
      if (pos >= text.length || c < 0x20) return stop();
      if (c === 0x22) break;
      if (c === 0x5c) {
        pos++;
        const e = text[pos];
        if (e === 'u') {
          HEX4.lastIndex = pos + 1;
          if (!HEX4.test(text)) {
            pos++;
            return stop();
          }
          pos += 4;
        } else if (e === undefined || !'"\\/bfnrt'.includes(e)) return stop();
      }
      pos++;
    }
    pos++;
    return JSON.parse(text.slice(from, pos)) as string;
  };

  const value = (key?: number): JsonNode => {
    const line = lineAt(starts, pos);
    const base = key === undefined ? { line } : { line, keyLine: key };
    const c = text[pos];
    if (c === '{') {
      pos++;
      const members = new Map<string, JsonNode>();
      skip();
      if (text[pos] === '}') pos++;
      else {
        for (;;) {
          skip();
          if (text[pos] !== '"') stop();
          const keyAt = lineAt(starts, pos);
          const name = string();
          skip();
          expect(':');
          skip();
          members.set(name, value(keyAt));
          skip();
          if (text[pos] === ',') pos++;
          else {
            expect('}');
            break;
          }
        }
      }
      return { ...base, members };
    }
    if (c === '[') {
      pos++;
      const items: JsonNode[] = [];
      skip();
      if (text[pos] === ']') pos++;
      else {
        for (;;) {
          skip();
          items.push(value());
          skip();
          if (text[pos] === ',') pos++;
          else {
            expect(']');
            break;
          }
        }
      }
      return { ...base, items };
    }
    if (c === '"') return { ...base, text: string() };
    for (const word of ['true', 'false', 'null']) {
      if (text.startsWith(word, pos)) {
        pos += word.length;
        return base;
      }
    }
    NUMBER.lastIndex = pos;
    const number = NUMBER.exec(text);
    if (number === null) return stop();
    pos += number[0].length;
    return base;
  };

  try {
    skip();
    const root = value();
    skip();
    if (pos < text.length) stop();
    return { root };
  } catch (error) {
    if (error instanceof Stop) {
      let at = error.offset;
      // Текст оборвался: ошибка там, где он кончился, а не на пустых строках после него.
      if (at >= text.length) {
        at = text.length - 1;
        while (at > 0 && WHITESPACE.has(text.charCodeAt(at))) at--;
      }
      return { errorLine: lineAt(starts, Math.max(at, 0)) };
    }
    // Слишком глубокая вложенность: строк нет, проверка манифеста от этого не падает.
    if (error instanceof RangeError) return {};
    throw error;
  }
}

interface Hit {
  readonly node: JsonNode;
  /** Хвост пути, до которого дойти не удалось; пусто - путь найден целиком. */
  readonly rest: string;
}

/** Путь `ui.views.main` или `contributes.menus[1].id`: ключи объектов (в них бывают точки: `cyborg.files`, `ui.lock`) и номера элементов. Дальше всего зашедший разбор. */
function descend(node: JsonNode, rest: string): Hit {
  if (rest === '') return { node, rest };
  let best: Hit = { node, rest };
  const step = (next: JsonNode, tail: string): void => {
    if (tail !== '' && !tail.startsWith('.') && !tail.startsWith('[')) return;
    const hit = descend(next, tail.startsWith('.') ? tail.slice(1) : tail);
    if (hit.rest.length < best.rest.length) best = hit;
  };
  if (node.members !== undefined) {
    for (const [key, child] of node.members) {
      if (key !== '' && rest.startsWith(key)) step(child, rest.slice(key.length));
    }
  } else if (node.items !== undefined) {
    const index = /^\[([0-9]+)\]/.exec(rest);
    const item = index?.[1] === undefined ? undefined : node.items[Number(index[1])];
    if (index !== null && item !== undefined) step(item, rest.slice(index[0].length));
  }
  return best;
}

const container = (node: JsonNode): boolean => node.members !== undefined || node.items !== undefined;

/** Строки ошибок одного манифеста. */
export interface ManifestLines {
  /** Строка, к которой относится сообщение `parseManifest`: ошибка в существующем ключе - строка ключа; не хватает обязательного ключа - строка начала объекта, где он должен быть. */
  readonly forMessage: (message: string) => number | undefined;
  /** Строка ключа по пути `ui.views.main`; нет такого ключа - `undefined`. */
  readonly forKey: (path: string) => number | undefined;
}

export function manifestLines(root: JsonNode | undefined): ManifestLines {
  if (root === undefined) return { forMessage: () => undefined, forKey: () => undefined };
  const forKey = (path: string): number | undefined => {
    const hit = descend(root, path);
    return hit.rest === '' ? (hit.node.keyLine ?? hit.node.line) : undefined;
  };
  const forMessage = (message: string): number => {
    const at = message.indexOf(': ');
    const path = at < 0 ? '' : message.slice(0, at);
    const reason = at < 0 ? message : message.slice(at + 2);
    const hit = descend(root, path);
    const { node, rest } = hit;
    if (rest === '') {
      // Ошибка об одном из имён списка или объекта команд: строка этого имени.
      if (path === 'commands') {
        const named = [...(node.members ?? [])].find(([name]) => reason.startsWith(`"${name}"`));
        if (named !== undefined) return named[1].keyLine ?? named[1].line;
        const listed = node.items?.find((item) => item.text !== undefined && reason.startsWith(`"${item.text}"`));
        if (listed !== undefined) return listed.line;
      }
      return node.keyLine ?? node.line;
    }
    // Сочетание в списке `keybindings` названо в сообщении нормализованным: повтор - это последний элемент с ним, остальное - единственный.
    if (path.startsWith('keybindings.') && node.items !== undefined && path === `keybindings.${rest}`) {
      const same = node.items.filter((item) => {
        const key = item.members?.get('key')?.text;
        return key !== undefined && normalizeKey(key) === rest;
      });
      const found = reason.includes('повторяется') ? same.at(-1) : same[0];
      if (found !== undefined) return found.line;
    }
    // Контракт в requires, optional и consumes назван без раздела: `<имя>: контракт ...`.
    if (node === root && rest === path) {
      const section = reason.includes('кратности many') ? 'consumes' : reason.includes('одновременно в requires и optional') ? 'optional' : undefined;
      const entry = section === undefined ? undefined : root.members?.get(section)?.members?.get(path);
      if (entry !== undefined) return entry.keyLine ?? entry.line;
    }
    // Не хватает ключа (или путь идёт мимо): начало объекта, где он должен лежать. Значение не объект - ошибка о нём самом.
    return container(node) ? node.line : (node.keyLine ?? node.line);
  };
  return { forMessage, forKey };
}

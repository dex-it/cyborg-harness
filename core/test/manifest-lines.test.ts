import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { layoutJson, manifestLines, type JsonNode } from '../src/manifest-lines.ts';
import { parseManifest } from '../src/manifest.ts';

// FR-CH-7005: строки в исходном JSON манифеста. Лёгкий разбор положений ключей сверяется с JSON.parse (годность, состав, порядок значений) и с независимым счётом строк.

const parses = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** Форма значения из JSON.parse: объекты и массивы целиком, листья - строки как есть, остальное - маркер. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(shapeOf);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, shapeOf(v)]));
  return typeof value === 'string' ? value : '<лист>';
}
function shapeOfNode(node: JsonNode): unknown {
  if (node.items) return node.items.map(shapeOfNode);
  if (node.members) return Object.fromEntries([...node.members].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, shapeOfNode(v)]));
  return node.text ?? '<лист>';
}

describe('layoutJson: согласие с JSON.parse', () => {
  const VALID = [
    '{}', '[]', '0', '-0', '1.5e+10', '"x"', 'true', 'false', 'null', ' \t\r\n{ }\n',
    '{"a":{"b":[1,2,{"c":null}]},"d":"\\u00e9\\n\\"\\\\\\/"}',
    '{"":1,"__proto__":{"x":1},"constructor":2}',
    '{"a":1,"a":2,"b":{"c":1,"c":[1]}}',
    '"\\ud800"', '[[[[[[[[[[1]]]]]]]]]]', '{"a" :\n 1 ,\r\n "b"\r:\r[ ]}',
    '{"ключ":"значение","эмодзи":"\u{1f600}"}', '{"u2028":"\u2028\u2029"}',
  ];
  const INVALID = [
    '', ' ', '\n\n', '{', '}', '[', '{"a":}', '{"a" 1}', '{"a":1,}', '[1,]', '[,1]', '{,}', "{'a':1}", '{a:1}', '{"a":1}}', '{"a":1} x', '01', '1.', '.5', '-', '+1', '1e', '1e+', 'NaN', 'Infinity',
    'tru', 'trueX', 'nul', '"abc', '"a\nb"', '"a\tb"', '"\\x"', '"\\u12"', '"\\u12G4"', '"\\', '\uFEFF{}', '{"a":1 "b":2}', '{"a":/*c*/1}', '// c\n{}', '[1 2]', '{"a":"b" "c"}', '{"a"}', '{"a":', '{"a":1', '[1', '"\u0001"',
  ];

  it('годные документы: дерево совпадает с JSON.parse', () => {
    for (const text of VALID) {
      assert.ok(parses(text), text);
      const layout = layoutJson(text);
      assert.ok(layout.root, text);
      assert.deepEqual(shapeOfNode(layout.root), shapeOf(JSON.parse(text)), text);
    }
  });

  it('негодные документы: ошибка со строкой в пределах текста, дерева нет', () => {
    for (const text of INVALID) {
      assert.equal(parses(text), false, JSON.stringify(text));
      const layout = layoutJson(text);
      assert.equal(layout.root, undefined, JSON.stringify(text));
      assert.ok(typeof layout.errorLine === 'number' && layout.errorLine >= 1 && layout.errorLine <= text.split(/\r\n|\n|\r/).length, `${JSON.stringify(text)} -> ${String(layout.errorLine)}`);
    }
  });

  it('строка сбоя: лишний символ - его строка, обрыв - строка последнего значащего символа', () => {
    assert.equal(layoutJson('{\n  "a": 1,\n}').errorLine, 3);
    assert.equal(layoutJson('{\r\n  "a": }\r\n}').errorLine, 2);
    assert.equal(layoutJson('{\n  "a": 1,\n\n\n').errorLine, 2);
    assert.equal(layoutJson('{\n  "a": "abc\n').errorLine, 2);
    assert.equal(layoutJson('').errorLine, 1);
    assert.equal(layoutJson('\n\n\n').errorLine, 1);
    assert.equal(layoutJson('[1,\r2,\r3 4]').errorLine, 3);
  });

  it('случайные правки годных документов: годность та же, что у JSON.parse', () => {
    const rnd = prng(7);
    const alphabet = ['"', '{', '}', '[', ']', ',', ':', '\\', '\n', '\r', '\t', ' ', '0', '1', '-', 'e', '.', 't', 'n', 'u', '\u0001', '\uFEFF', 'x', '/'];
    let agreed = 0;
    for (const base of [...VALID, pretty(randomValue(rnd, 4), 2, '\n').text, pretty(randomValue(rnd, 4), 0, '\r\n').text]) {
      for (let i = 0; i < 400; i++) {
        let text = base;
        for (let n = 1 + Math.floor(rnd() * 2); n > 0; n--) {
          const at = Math.floor(rnd() * (text.length + 1));
          const pick = alphabet[Math.floor(rnd() * alphabet.length)] ?? '';
          const kind = Math.floor(rnd() * 3);
          text = kind === 0 ? text.slice(0, at) + pick + text.slice(at) : kind === 1 ? text.slice(0, at) + text.slice(at + 1) : text.slice(0, at) + pick + text.slice(at + 1);
        }
        const layout = layoutJson(text);
        assert.equal(layout.root !== undefined, parses(text), JSON.stringify(text));
        if (layout.root !== undefined) assert.deepEqual(shapeOfNode(layout.root), shapeOf(JSON.parse(text)), JSON.stringify(text));
        else assert.equal(typeof layout.errorLine, 'number', JSON.stringify(text));
        agreed++;
      }
    }
    assert.ok(agreed > 5000);
  });

  it('очень глубокая вложенность не роняет разбор', () => {
    const deep = '['.repeat(200_000) + ']'.repeat(200_000);
    assert.ok(parses(deep));
    assert.doesNotThrow(() => layoutJson(deep));
    assert.doesNotThrow(() => layoutJson('['.repeat(200_000)));
  });
});

// Независимый счёт строк: текст собирается так, что номер строки каждого ключа известен при записи.
type Tree = string | number | null | readonly Tree[] | { readonly [key: string]: Tree };

function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomValue(rnd: () => number, depth: number): Tree {
  const r = rnd();
  if (depth <= 0 || r < 0.35) return r < 0.1 ? null : r < 0.2 ? Math.floor(rnd() * 1000) : `s${String(Math.floor(rnd() * 50))}`;
  if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 4) }, () => randomValue(rnd, depth - 1));
  const out: Record<string, Tree> = {};
  for (let i = Math.floor(rnd() * 5); i > 0; i--) out[`k${String(Math.floor(rnd() * 6))}.${rnd() < 0.3 ? 'x' : String(i)}`] = randomValue(rnd, depth - 1);
  return out;
}

/** Текст дерева с отступом `indent` (0 - без переводов строки, кроме `eol` между ключами корня не ставится) и ожидаемыми строками ключей по пути. */
function pretty(tree: Tree, indent: number, eol: string): { text: string; keys: Map<string, number> } {
  let text = '';
  let line = 1;
  const keys = new Map<string, number>();
  const nl = (level: number): void => {
    if (indent === 0) return;
    text += eol + ' '.repeat(indent * level);
    line++;
  };
  const write = (value: Tree, level: number, path: string): void => {
    if (Array.isArray(value)) {
      text += '[';
      value.forEach((item, i) => {
        nl(level + 1);
        write(item as Tree, level + 1, `${path}[${String(i)}]`);
        if (i < value.length - 1) text += ',';
      });
      if (value.length > 0) nl(level);
      text += ']';
    } else if (typeof value === 'object' && value !== null) {
      text += '{';
      const entries = Object.entries(value);
      entries.forEach(([key, item], i) => {
        nl(level + 1);
        keys.set(path === '' ? key : `${path}.${key}`, line);
        text += `${JSON.stringify(key)}:${indent > 0 ? ' ' : ''}`;
        write(item, level + 1, path === '' ? key : `${path}.${key}`);
        if (i < entries.length - 1) text += ',';
      });
      if (entries.length > 0) nl(level);
      text += '}';
    } else text += JSON.stringify(value);
  };
  write(tree, 0, '');
  return { text, keys };
}

describe('layoutJson: строки ключей против независимого счёта', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    it(`случайные документы, перевод строки ${JSON.stringify(eol)}`, () => {
      const rnd = prng(eol.length * 31 + eol.charCodeAt(0));
      let checked = 0;
      for (let i = 0; i < 150; i++) {
        const tree = randomValue(rnd, 5);
        const { text, keys } = pretty(tree, 1 + (i % 3), eol);
        const layout = layoutJson(text);
        assert.ok(layout.root, text);
        const { forKey } = manifestLines(layout.root);
        for (const [pathKey, line] of keys) {
          // Путь ключей с точками внутри (`k1.x`) однозначен только в этом генераторе: проверяем те пути, что разбор находит.
          const found = forKey(pathKey);
          if (found !== undefined) {
            assert.equal(found, line, `${pathKey}\n${text}`);
            checked++;
          }
        }
      }
      assert.ok(checked > 300, String(checked));
    });
  }

  it('одинаковые ключи: строка последнего', () => {
    const { root } = layoutJson('{\n"a": 1,\n"b": {\n"c": 1,\n"a": 2,\n"c": 3\n},\n"a": 4\n}');
    assert.equal(manifestLines(root).forKey('a'), 8);
    assert.equal(manifestLines(root).forKey('b.c'), 6);
  });
});

describe('manifestLines: сообщение parseManifest -> строка', () => {
  const doc = [
    '{',                                                  // 1
    '  "id": "acme.hello",',                              // 2
    '  "version": "1.0.0",',                              // 3
    '  "engines": { "cyborg": "^1" },',                   // 4
    '  "requires": {',                                    // 5
    '    "acme.base": "^1"',                              // 6
    '  },',                                               // 7
    '  "optional": {',                                    // 8
    '    "acme.base": "^1",',                             // 9
    '    "bad name": "^1"',                               // 10
    '  },',                                               // 11
    '  "consumes": {',                                    // 12
    '    "acme.base": "^1"',                              // 13
    '  },',                                               // 14
    '  "commands": {',                                    // 15
    '    "acme.hello.run": {},',                          // 16
    '    "other.run": {},',                               // 17
    '    "acme.hello.go": { "args": ["bogus"] }',         // 18
    '  },',                                               // 19
    '  "keybindings": [',                                 // 20
    '    { "key": "ctrl+k", "command": "acme.hello.run" },', // 21
    '    { "key": "Ctrl+K", "command": "acme.hello.run" }', // 22
    '  ],',                                               // 23
    '  "permissions": { "ui.lock": true },',              // 24
    '  "provides": {',                                    // 25
    '    "acme.api": { "version": "1.0.0", "bogus": 1 }', // 26
    '  },',                                               // 27
    '  "contributes": {',                                 // 28
    '    "menus": [',                                     // 29
    '      { "id": "open", "menu": "file", "title": "A", "command": "acme.hello.run" },', // 30
    '      { "id": "Bad", "menu": "file", "title": "A", "command": "acme.hello.run" }',   // 31
    '    ]',                                              // 32
    '  }',                                                // 33
    '}',                                                  // 34
  ].join('\n');
  const result = parseManifest(JSON.parse(doc));
  const errors = result.ok ? [] : result.errors;
  const lines = manifestLines(layoutJson(doc).root);
  const lineOf = (start: string): number | undefined => {
    const found = errors.filter((e) => e.startsWith(start));
    assert.equal(found.length, 1, `${start}\n${errors.join('\n')}`);
    return lines.forMessage(found[0] ?? '');
  };

  it('ошибка контракта, названного без раздела: строка записи в разделе', () => {
    assert.equal(lineOf('acme.base: контракт одновременно'), 9);
    assert.equal(lineOf('acme.base: контракт кратности many'), 13);
    assert.equal(lineOf('optional.bad name'), 10);
  });

  it('команды: имя в объекте - его строка; вложенный ключ с точками в имени; незнакомый вид в args', () => {
    assert.equal(lineOf('commands: "other.run"'), 17);
    assert.equal(lineOf('commands.acme.hello.go.args'), 18);
  });

  it('сочетания: единственный элемент и повтор (последний элемент с этим сочетанием)', () => {
    assert.equal(lineOf('keybindings.Ctrl+K: сочетание повторяется'), 22);
  });

  it('ключ с точкой (permissions."ui.lock"), вложенный ключ, элемент массива по номеру', () => {
    assert.equal(lineOf('permissions.ui.lock'), 24);
    assert.equal(lineOf('provides.acme.api.bogus'), 26);
    assert.equal(lineOf('contributes.menus[1].id'), 31);
  });

  it('forKey: нет ключа - undefined', () => {
    assert.equal(lines.forKey('permissions.ui.lock'), 24);
    assert.equal(lines.forKey('permissions.net'), undefined);
    assert.equal(lines.forKey('contributes.menus[1].id'), 31);
    assert.equal(lines.forKey('contributes.menus[2].id'), undefined);
  });

  it('без дерева (слишком глубокий документ) строки нет', () => {
    const none = manifestLines(undefined);
    assert.equal(none.forMessage('id: x'), undefined);
    assert.equal(none.forKey('id'), undefined);
  });

  it('сообщение без пути и корень не объект: строка значения', () => {
    assert.equal(manifestLines(layoutJson('\n\n[1]').root).forMessage('манифест не объект'), 3);
    assert.equal(manifestLines(layoutJson('{\n\n}').root).forMessage('id: ожидается имя, получено ничего'), 1);
  });
});

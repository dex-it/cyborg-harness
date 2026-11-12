import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MANIFEST_KEYS, parseManifest } from '../src/manifest.ts';
import { AREAS } from '../src/manifest-layout.ts';
import { MENU_NAMES } from '../src/manifest-menus.ts';
import { PERMISSION_KEYS } from '../src/permissions.ts';
import { GUARD_RIGHTS } from '../src/via-contract.ts';
import { isWireKind } from '../src/wire.ts';
import { KERNEL_COMMANDS, reservedId, WINDOW_COMMANDS } from '../src/window-layer.ts';
import { validateDraft } from './schema-draft.ts';

// P-04 (#38): contracts/manifest.schema.json - второй источник правды о манифесте после core/src/manifest.ts. Тест держит их вместе:
// (1) поля схемы совпадают с ключами разбора; (2) манифесты всех примеров получают от схемы и от parseManifest один итог;
// (3) таблица правок одного манифеста: где схема и разбор расходятся, расхождение названо (схема не видит связей между полями).
const repo = path.resolve(import.meta.dirname, '..', '..');
const schemaPath = path.join(repo, 'contracts', 'manifest.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
type Json = Record<string, unknown>;
const definitions = schema.definitions as Record<string, Json>;
const properties = schema.properties as Record<string, Json>;

const bySchema = (manifest: unknown): boolean => validateDraft(schema, manifest).length === 0;
const byCore = (manifest: unknown): boolean => parseManifest(manifest).ok;

function manifests(): { name: string; manifest: unknown }[] {
  const roots = ['playground/plugins', 'core/examples/plugins'];
  const out: { name: string; manifest: unknown }[] = [];
  for (const root of roots) {
    for (const entry of fs.readdirSync(path.join(repo, root), { withFileTypes: true })) {
      const file = path.join(repo, root, entry.name, 'manifest.json');
      if (entry.isDirectory() && fs.existsSync(file)) out.push({ name: `${root}/${entry.name}`, manifest: JSON.parse(fs.readFileSync(file, 'utf8')) });
    }
  }
  for (const dir of ['templates/plugin', 'templates/plugin/test/consumer']) {
    out.push({ name: dir, manifest: JSON.parse(fs.readFileSync(path.join(repo, dir, 'manifest.json'), 'utf8')) });
  }
  return out;
}

describe('схема манифеста и core/src/manifest.ts: два источника правды', () => {
  it('поля верхнего уровня схемы - ровно ключи разбора (TOP_LEVEL)', () => {
    assert.deepEqual(Object.keys(properties).sort(), [...MANIFEST_KEYS].sort());
    assert.equal(schema.additionalProperties, false, 'незнакомое поле схема отклоняет, как ядро');
  });

  it('обязательные поля схемы - то, без чего разбор отказывает', () => {
    for (const key of schema.required as string[]) {
      const m: Json = Object.fromEntries(Object.entries({ id: 'a', version: '1.0.0', engines: { cyborg: '^1' } }).filter(([name]) => name !== key));
      assert.equal(byCore(m), false, `${key}: ядро принимает манифест без него`);
    }
    assert.deepEqual([...(schema.required as string[])].sort(), ['engines', 'id', 'version']);
  });

  it('перечни схемы совпадают с перечнями ядра: области, меню, права для guard, права плагина', () => {
    assert.deepEqual(definitions.area?.enum, [...AREAS]);
    assert.deepEqual((properties.contributes?.properties as Json).menus && ((((properties.contributes?.properties as Json).menus as Json).items as Json).properties as Json).menu, { enum: [...MENU_NAMES] });
    assert.deepEqual(Object.keys(definitions.guardRights?.properties as Json), [...GUARD_RIGHTS]);
    assert.deepEqual(Object.keys(properties.permissions?.properties as Json).sort(), [...PERMISSION_KEYS].sort());
    assert.deepEqual(definitions.areaDocument?.enum, AREAS.filter((a) => a !== 'modal'));
  });

  it('виды аргументов команды схемы узнаёт и ядро; чужих имён ядро не знает', () => {
    const pattern = (((properties.commands?.oneOf as Json[])[1]?.additionalProperties as Json).properties as Json).args as Json;
    const kinds = /\(\?:([^)]*)\)/.exec(((pattern.items as Json).pattern as string))?.[1]?.split('|') ?? [];
    assert.equal(kinds.length, 7);
    for (const kind of kinds) assert.equal(isWireKind(kind), true, kind);
    for (const alien of ['object', 'integer', 'null', 'function']) assert.equal(isWireKind(alien), false, alien);
    assert.deepEqual((((properties.commands?.oneOf as Json[])[1]?.additionalProperties as Json).properties as Json).rest, { enum: kinds });
  });

  it('занятые id схемы - ровно id, чьи команды заняты окном и ядром', () => {
    const reserved = ((properties.id?.allOf as Json[])[1]?.not as Json).enum as string[];
    const prefixes = new Set<string>();
    for (const command of [...Object.keys(WINDOW_COMMANDS), ...Object.values(KERNEL_COMMANDS)]) {
      const parts = command.split('.');
      for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join('.'));
    }
    assert.deepEqual([...reserved].sort(), [...prefixes].sort());
    for (const id of reserved) assert.equal(reservedId(id), true, id);
  });
});

describe('схема и parseManifest на манифестах примеров', () => {
  const all = manifests();

  it('находит манифесты стенда, примеров ядра и шаблона', () => {
    assert.ok(all.length >= 40, `найдено ${String(all.length)}`);
    assert.ok(all.some((m) => m.name === 'templates/plugin'));
    assert.ok(all.some((m) => m.name === 'core/examples/plugins/broken-manifest'));
  });

  for (const { name, manifest } of manifests()) {
    it(`${name}: итог схемы и parseManifest одинаков`, () => {
      const expected = name === 'core/examples/plugins/broken-manifest' ? false : true;
      assert.equal(byCore(manifest), expected, 'итог parseManifest');
      assert.deepEqual(validateDraft(schema, manifest).length === 0, expected, `итог схемы: ${validateDraft(schema, manifest).join('; ')}`);
    });
  }
});

/** Манифест, где заняты почти все поля; разбор и схема принимают его. */
const BASE = {
  $schema: './node_modules/@cyborg-harness/contracts/manifest.schema.json',
  id: 'acme.demo',
  version: '1.2.3',
  engines: { cyborg: '^1.0' },
  provides: { 'acme.demo-api': { version: ['1.0', '2.1'], guard: { read: { 'fs.read': '0.path' } }, deprecated: ['old'] }, 'acme.other': '1.0' },
  requires: { 'cyborg.agent': '^1' },
  optional: { 'cyborg.git': '*' },
  consumes: { 'cyborg.session-prompt': '1' },
  commands: { 'acme.demo.open': {}, 'acme.demo.read': { args: ['string', 'number?'], callers: 'plugins', guard: { 'fs.read': 0 } }, 'acme.demo.run': { args: [], rest: 'any' } },
  keybindings: [{ key: 'CmdOrCtrl+Shift+E', command: 'acme.demo.open' }],
  contributes: { menus: [{ id: 'open', menu: 'tools', title: 'Открыть', command: 'acme.demo.open', order: 5, accelerator: 'CmdOrCtrl+Alt+O', enabled: { contract: 'cyborg.git', major: 1, member: 'isOn' } }] },
  permissions: {
    'fs.read': ['workspace', '~/notes/**', '/opt/data'],
    'fs.write': ['plugin-data', 'workspace.git'],
    shell: ['any', 'https:'],
    process: ['git', { program: 'npm', args: ['test'], env: ['CI', 'GIT_CONFIG_KEY_*'], deny: ['--prefix', '-g'] }, { program: '$SHELL', args: ['-lc', 'exec tool "$@"', 'cyborg'] }],
    pty: ['bash', { program: 'claude', args: [], deny: ['--dangerously-skip-permissions'] }],
    launch: ['claude'],
    net: ['api.github.com', 'localhost:8080', 'config:baseUrl'],
    env: ['HOME'],
    notify: true,
    clipboard: ['read', 'write'],
    'secrets.ref': ['vault://kv/data/jira*'],
    'security.roots': true,
    serve: true,
  },
  config: { version: 2, schema: './config.schema.json' },
  state: { version: 1 },
  ui: { views: { main: './ui/main.js', side: { module: './ui/side.js', area: 'sidebar', order: 100, title: 'Сбоку' } }, group: 'acme', inlineStyles: true },
  documents: { note: { restorable: true, area: 'main', order: 1 } },
  host: 'own',
  activation: 'lazy',
};

type Patch = (m: Json) => void;
const put = (pathText: string, value: unknown): Patch => (m) => {
  const keys = pathText.split('/');
  let node = m;
  for (const key of keys.slice(0, -1)) node = node[key] as Json;
  const last = keys[keys.length - 1] ?? '';
  if (value === undefined) Reflect.deleteProperty(node, last);
  else node[last] = value;
};
const many = (n: number, make: (i: number) => [string, unknown]): Json => Object.fromEntries(Array.from({ length: n }, (_, i) => make(i)));

/** Правки, после которых и схема, и ядро отказывают: поле, ограничение которого схема обязана знать. */
const BOTH_REJECT: Record<string, Patch> = {
  'лишнее поле верхнего уровня': put('extra', 1),
  'id в верхнем регистре': put('id', 'Acme'),
  'id занят окном ядра': put('id', 'cyborg.window'),
  'id занят пространством cyborg': put('id', 'cyborg'),
  'нет id': put('id', undefined),
  'version не версия': put('version', 'latest'),
  'version с предрелизом': put('version', '1.0.0-beta'),
  'нет engines': put('engines', undefined),
  'engines.cyborg не диапазон': put('engines/cyborg', 'latest'),
  'engines.cyborg с буквой': put('engines/cyborg', '^x'),
  'provides: версия не версия': put('provides/acme.other', 'x'),
  'provides: пустой список версий': put('provides/acme.other', []),
  'provides: объект без version': put('provides/acme.other', { guard: {} }),
  'provides: лишний ключ объекта': put('provides/acme.other', { version: '1.0', extra: 1 }),
  'provides: имя контракта с заглавной': put('provides/Bad', '1.0'),
  'guard: право не для аргумента': put('provides/acme.demo-api/guard/read', { 'fs.exec': 0 }),
  'guard: номер аргумента не число': put('provides/acme.demo-api/guard/read', { 'fs.read': 'x' }),
  'guard: пустой список прав': put('provides/acme.demo-api/guard/read', {}),
  'deprecated не список': put('provides/acme.demo-api/deprecated', 'old'),
  'deprecated: имя члена с цифры': put('provides/acme.demo-api/deprecated', ['1a']),
  'requires: не диапазон': put('requires/cyborg.agent', 'x'),
  'requires: плохое имя контракта': put('requires/Bad', '^1'),
  'commands: повтор имени в списке': put('commands', ['acme.demo.a', 'acme.demo.a']),
  'commands: имя в верхнем регистре': put('commands', ['acme.demo.Open']),
  'commands: неизвестный вид аргумента': put('commands/acme.demo.read/args', ['int']),
  'commands: неизвестный вид rest': put('commands/acme.demo.run/rest', 'int'),
  'commands: callers не из списка': put('commands/acme.demo.read/callers', 'all'),
  'commands: guard не объект': put('commands/acme.demo.read/guard', 'fs.read'),
  'commands: не список и не объект': put('commands', 'acme.demo.open'),
  'keybindings не список': put('keybindings', 'x'),
  'keybindings: нет command': put('keybindings', [{ key: 'F5' }]),
  'permissions: незнакомое право': put('permissions/sudo', true),
  'fs.read: относительный путь': put('permissions/fs.read', ['src']),
  'fs.read: выход наверх': put('permissions/fs.read', ['/a/../b']),
  'fs.read: маска в первом имени': put('permissions/fs.read', ['/*']),
  'fs.read: ** внутри имени': put('permissions/fs.read', ['~/a**b']),
  'fs.read: не список': put('permissions/fs.read', 'workspace'),
  'fs.write: чужая область': put('permissions/fs.write', ['everything']),
  'shell: схема file:': put('permissions/shell', ['file:']),
  'shell: схема javascript:': put('permissions/shell', ['javascript:']),
  'net: недопустимый хост': put('permissions/net', ['bad host!']),
  'env: имя с цифры': put('permissions/env', ['1BAD']),
  'secrets.ref: без схемы': put('permissions/secrets.ref', ['vault']),
  'clipboard: чужое слово': put('permissions/clipboard', ['copy']),
  'notify не булево': put('permissions/notify', 'yes'),
  'process: оболочка строкой': put('permissions/process', ['$SHELL']),
  'process: оболочка без скрипта': put('permissions/process', [{ program: '$SHELL', args: ['-lc'] }]),
  'process: правило без args': put('permissions/process', [{ program: 'git' }]),
  'process: deny не список': put('permissions/process', [{ program: 'git', args: [], deny: '--output' }]),
  'process: deny с пустой строкой': put('permissions/process', [{ program: 'git', args: [], deny: [''] }]),
  'process: deny с не строкой': put('permissions/process', [{ program: 'git', args: [], deny: [1] }]),
  'pty: deny с пустой строкой': put('permissions/pty', [{ program: 'claude', args: [], deny: [''] }]),
  'launch: deny не у запуска': put('permissions/launch', [{ program: 'claude', args: [], deny: ['--x'] }]),
  'process: env с чужим именем': put('permissions/process', [{ program: 'git', args: [], env: ['1BAD'] }]),
  'config.version ноль': put('config/version', 0),
  'config.version строкой': put('config/version', '1'),
  'config.schema вверх': put('config/schema', '../x.json'),
  'config.schema без ./': put('config/schema', 'x.json'),
  'state не объект': put('state', 1),
  'ui пустой': put('ui', {}),
  'ui без видов': put('ui/views', {}),
  'ui: вид с именем overlay': put('ui/views', { overlay: './x.js' }),
  'ui: имя вида в верхнем регистре': put('ui/views', { Main: './x.js' }),
  'ui: модуль .ts': put('ui/views/main', './ui/main.ts'),
  'ui: модуль вверх': put('ui/views/main', '../main.js'),
  'ui: модуль абсолютный': put('ui/views/main', '/main.js'),
  'ui: область overlay у вида': put('ui/views/side/area', 'overlay'),
  'ui: заголовок длиннее 80': put('ui/views/side/title', 'я'.repeat(81)),
  'ui: order не число': put('ui/views/side/order', '1'),
  'ui: лишний ключ ui': put('ui/extra', 1),
  'ui.group в верхнем регистре': put('ui/group', 'Acme'),
  'ui.inlineStyles не булево': put('ui/inlineStyles', 'yes'),
  'documents пустой': put('documents', {}),
  'documents: 17 типов': put('documents', many(17, (i) => [`t${String.fromCharCode(97 + i)}`, {}])),
  'documents: модальная область': put('documents/note/area', 'modal'),
  'documents: restorable строкой': put('documents/note/restorable', 'yes'),
  'documents: лишний ключ': put('documents/note/extra', 1),
  'host не own': put('host', 'shared'),
  'activation не lazy': put('activation', 'eager'),
  'lock: onStart false': put('lock', { onStart: false }),
  'lock: пустой': put('lock', {}),
  'contributes: незнакомое поле': put('contributes/extra', 1),
  'contributes: пустой список пунктов': put('contributes/menus', []),
  'menus: меню вне списка': put('contributes/menus', [{ id: 'a', menu: 'file', title: 'T', command: 'acme.demo.open' }]),
  'menus: пустой заголовок': put('contributes/menus', [{ id: 'a', menu: 'tools', title: '', command: 'acme.demo.open' }]),
  'menus: нет command': put('contributes/menus', [{ id: 'a', menu: 'tools', title: 'T' }]),
  'menus: major дробный': put('contributes/menus', [{ id: 'a', menu: 'tools', title: 'T', command: 'acme.demo.open', enabled: { contract: 'cyborg.git', major: 1.5, member: 'isOn' } }]),
  'menus: 33 пункта': put('contributes/menus', Array.from({ length: 33 }, (_, i) => ({ id: `i${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, menu: 'tools', title: 'T', command: 'acme.demo.open' }))),
};

/** Расхождения: схема принимает то, что ядро отвергает, потому что JSON Schema не видит связей между полями. Список назван в справочнике манифеста. */
const SCHEMA_LOOSER: Record<string, Patch> = {
  'команда вне пространства имён плагина': put('commands', ['other.cmd']),
  'привязка клавиши к неизвестной команде': put('keybindings', [{ key: 'F5', command: 'acme.demo.missing' }]),
  'привязка клавиши, которую нельзя разобрать': put('keybindings', [{ key: '???', command: 'acme.demo.open' }]),
  'контракт сразу в requires и optional': put('optional', { 'cyborg.agent': '^1' }),
  'контракт кратности many в requires': put('requires', { 'cyborg.session-prompt': '1' }),
  'две версии одной мажорной в provides': put('provides/acme.other', ['1.0', '1.1']),
  'необязательный аргумент перед обязательным': put('commands/acme.demo.read/args', ['number?', 'string']),
  'rest вместе с необязательными аргументами': put('commands/acme.demo.read/rest', 'string'),
  'guard команды без callers: "plugins"': put('commands/acme.demo.read/callers', 'user'),
  'право ui.lock без ui.overlay': put('permissions/ui.lock', true),
  'lock.onStart без права ui.lock': put('lock', { onStart: true }),
  'ui.overlay без права ui.lock': put('ui/overlay', './ui/overlay.js'),
  'источник пункта меню из контракта, которого нет в манифесте': put('contributes/menus', [{ id: 'a', menu: 'tools', title: 'T', command: 'acme.demo.open', enabled: { contract: 'acme.unknown', major: 1, member: 'isOn' } }]),
  'пункт меню с неизвестной командой': put('contributes/menus', [{ id: 'a', menu: 'tools', title: 'T', command: 'acme.demo.missing' }]),
  'сочетание пункта меню, которое нельзя разобрать': put('contributes/menus/0/accelerator', '+++'),
  'повтор id пункта меню': put('contributes/menus', [{ id: 'a', menu: 'tools', title: 'T', command: 'acme.demo.open' }, { id: 'a', menu: 'view', title: 'T', command: 'acme.demo.open' }]),
};

/** Схема строже ядра: ядро молча пропускает лишний ключ там, где схема его отклоняет (опечатка в имени ключа команды). */
const SCHEMA_STRICTER: Record<string, Patch> = {
  'лишний ключ в описании команды': put('commands/acme.demo.run/extra', 1),
};

const withPatch = (patch: Patch): Json => {
  const m = structuredClone(BASE) as Json;
  patch(m);
  return m;
};

describe('таблица правок одного манифеста: где схема и разбор согласны, а где нет', () => {
  it('исходный манифест принимают и схема, и ядро', () => {
    assert.deepEqual(validateDraft(schema, BASE), []);
    const parsed = parseManifest(BASE);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join('; '));
  });

  for (const [name, patch] of Object.entries(BOTH_REJECT)) {
    it(`обе стороны отказывают: ${name}`, () => {
      const m = withPatch(patch);
      assert.equal(byCore(m), false, 'ядро приняло');
      assert.equal(bySchema(m), false, 'схема приняла');
    });
  }

  for (const [name, patch] of Object.entries(SCHEMA_LOOSER)) {
    it(`известное расхождение, схема мягче: ${name}`, () => {
      const m = withPatch(patch);
      assert.equal(byCore(m), false, 'ядро приняло: расхождения нет, уберите правку из списка');
      assert.equal(bySchema(m), true, 'схема отказала: расхождения нет, уберите правку из списка');
    });
  }

  for (const [name, patch] of Object.entries(SCHEMA_STRICTER)) {
    it(`известное расхождение, схема строже: ${name}`, () => {
      const m = withPatch(patch);
      assert.equal(byCore(m), true, 'ядро отказало: расхождения нет, уберите правку из списка');
      assert.equal(bySchema(m), false, 'схема приняла: расхождения нет, уберите правку из списка');
    });
  }

  it('допустимые правки принимают обе стороны', () => {
    const ok: Record<string, Patch> = {
      'вид в краткой записи': put('ui/views/main', './main.js'),
      'область modal у вида': put('ui/views/side/area', 'modal'),
      'оболочка входа со скриптом': put('permissions/process', [{ program: '$SHELL', args: ['-lc', 'run'] }]),
      'схема URL https:': put('permissions/shell', ['https:', 'mailto:']),
      'сокращённая версия плагина': put('version', '1.2'),
      'engines со звёздочкой': put('engines/cyborg', '*'),
      'список команд': put('commands', ['acme.demo.open']),
      'без необязательного': put('host', undefined),
      'меню window': put('contributes/menus/0/menu', 'window'),
    };
    for (const [name, patch] of Object.entries(ok)) {
      const m = withPatch(patch);
      assert.equal(byCore(m), true, `ядро: ${name}`);
      assert.equal(bySchema(m), true, `схема: ${name}`);
    }
  });
});

describe('validateDraft: проверка держится в объёме, который проверен', () => {
  it('ключ вне перечня - исключение, а не молчаливый пропуск', () => {
    assert.throws(() => validateDraft({ patternProperties: {} }, {}), /не поддерживается/);
  });

  it('ссылка на несуществующее определение - исключение', () => {
    assert.throws(() => validateDraft({ $ref: '#/definitions/nope' }, 1), /не разрешается/);
  });

  it('oneOf требует ровно один вариант, not и uniqueItems работают', () => {
    assert.equal(validateDraft({ oneOf: [{ type: 'string' }, { minLength: 1 }] }, 'a').length > 0, true);
    assert.equal(validateDraft({ oneOf: [{ type: 'string' }, { type: 'number' }] }, 'a').length, 0);
    assert.equal(validateDraft({ not: { const: 1 } }, 1).length > 0, true);
    assert.equal(validateDraft({ uniqueItems: true }, [1, 1]).length > 0, true);
  });

  it('схема манифеста целиком лежит в объёме проверки (ни один ключ не пропущен)', () => {
    assert.doesNotThrow(() => validateDraft(schema, BASE));
    for (const { manifest } of manifests()) assert.doesNotThrow(() => validateDraft(schema, manifest));
  });
});

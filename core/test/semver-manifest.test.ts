import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowsMajor, satisfies, isValidRange } from '../src/semver.ts';
import { checkArgs, parseManifest, type CommandSpec } from '../src/manifest.ts';

test('диапазоны: каретка, тильда, префикс и звезда', () => {
  assert.ok(satisfies('1.4.0', '^1'));
  assert.ok(satisfies('1.9.9', '^1.4'));
  assert.ok(!satisfies('1.3.9', '^1.4'));
  assert.ok(!satisfies('2.0.0', '^1'));
  assert.ok(satisfies('0.2.5', '^0.2'));
  assert.ok(!satisfies('0.3.0', '^0.2'));
  assert.ok(!satisfies('0.0.4', '^0.0.3'));
  assert.ok(satisfies('1.2.9', '~1.2'));
  assert.ok(!satisfies('1.3.0', '~1.2'));
  assert.ok(satisfies('1.4', '1.4'));
  assert.ok(!satisfies('1.5', '1.4'));
  assert.ok(satisfies('7.0.0', '*'));
  assert.ok(!isValidRange('>=1'));
  assert.ok(!satisfies('1.x', '^1'));
});

test('allowsMajor: есть ли в диапазоне версия этой мажорной', () => {
  assert.ok(allowsMajor('^1.4', 1));
  assert.ok(!allowsMajor('^1.4', 2));
  assert.ok(!allowsMajor('^1.4', 0));
  assert.ok(allowsMajor('~0.2', 0));
  assert.ok(allowsMajor('*', 7));
  assert.ok(allowsMajor('2', 2));
  assert.ok(!allowsMajor('^1', 1.5));
  assert.ok(!allowsMajor('^1', -1));
});

const base = { id: 'pin-lock', version: '1.0.0', engines: { cyborg: '^1' } };

test('манифест: незнакомое поле верхнего уровня - отказ с именем поля, $schema разрешён', () => {
  const typo = parseManifest({ ...base, keybinding: [], lok: { onStart: true } });
  assert.deepEqual(typo, { ok: false, id: 'pin-lock', errors: ['keybinding: незнакомое поле манифеста', 'lok: незнакомое поле манифеста'] });
  assert.ok(parseManifest({ $schema: './manifest.schema.json', ...base }).ok);
});

test('манифест под другой API: при ошибках разбора одна причина - версия API', () => {
  const newer = { ...base, engines: { cyborg: '^1.3' }, layout: { kind: 'side' } };
  assert.deepEqual(parseManifest(newer, '1.2.0'), { ok: false, id: 'pin-lock', errors: ['engines.cyborg: нужен API Cyborg ^1.3, есть 1.2.0'] });
  assert.deepEqual(parseManifest(newer, '1.3.0'), { ok: false, id: 'pin-lock', errors: ['layout: незнакомое поле манифеста'] });
  assert.deepEqual(parseManifest(newer), { ok: false, id: 'pin-lock', errors: ['layout: незнакомое поле манифеста'] });
  assert.ok(parseManifest({ ...base, engines: { cyborg: '^2' } }, '1.2.0').ok, 'без ошибок разбора версию судит граф');
});

test('манифест: минимальный приводится к полной форме', () => {
  const r = parseManifest({ ...base, provides: { 'cyborg.lock': '1.0' } });
  assert.ok(r.ok);
  assert.deepEqual(r.manifest.provides, { 'cyborg.lock': ['1.0'] });
  assert.deepEqual(r.manifest.requires, {});
  assert.deepEqual(r.manifest.commands, {});
});

test('манифест: ошибки собираются все сразу и id сохраняется для журнала', () => {
  const r = parseManifest({
    ...base,
    version: 'one',
    engines: { cyborg: '>=1' },
    provides: { 'cyborg.lock': ['1.0', '1.2'] },
    requires: { 'cyborg.files': '^1' },
    optional: { 'cyborg.files': '^1' },
    commands: ['other.lock'],
    config: { version: 0 },
  });
  assert.ok(!r.ok);
  assert.equal(r.id, 'pin-lock');
  assert.equal(r.errors.length, 6);
});

test('манифест: контракт many не может быть одновременно one', () => {
  const r = parseManifest({ ...base, requires: { 'cyborg.tab': '^1' }, consumes: { 'cyborg.tab': '^1' } });
  assert.ok(!r.ok);
});

test('команды: список имён - без аргументов, объект - со схемой аргументов', () => {
  const short = parseManifest({ ...base, commands: ['pin-lock.lock'] });
  assert.ok(short.ok);
  assert.deepEqual(short.manifest.commands, { 'pin-lock.lock': { args: [] } });

  const full = parseManifest({ ...base, commands: { 'pin-lock.unlock': { args: ['string', 'number?'] }, 'pin-lock.log': { args: ['string'], rest: 'any' } } });
  assert.ok(full.ok);
  assert.deepEqual(full.manifest.commands['pin-lock.unlock'], {
    args: [
      { kind: 'string', optional: false },
      { kind: 'number', optional: true },
    ],
  });
  assert.equal(full.manifest.commands['pin-lock.log']?.rest, 'any');
});

test('команды: схема с ошибкой не проходит разбор', () => {
  const errors = (commands: unknown) => {
    const r = parseManifest({ ...base, commands });
    return r.ok ? '' : r.errors.join('\n');
  };
  assert.match(errors({ 'pin-lock.a': { args: ['date'] } }), /неизвестный вид "date"/);
  assert.match(errors({ 'pin-lock.a': { args: ['string?', 'number'] } }), /обязательный аргумент после необязательного/);
  assert.match(errors({ 'pin-lock.a': { args: ['string?'], rest: 'any' } }), /rest вместе с необязательными/);
  assert.match(errors({ 'pin-lock.a': { rest: 'thing' } }), /rest: неизвестный вид/);
  assert.match(errors({ 'pin-lock.a': 'string' }), /ожидается объект/);
  assert.match(errors({ 'other.a': {} }), /пространстве имён "pin-lock\."/);
  assert.match(errors(['pin-lock.a', 'pin-lock.a']), /имя повторяется/);
  assert.match(errors(5), /ожидается список имён или объект/);
});

test('команды: аргументы сверяются по числу и виду', () => {
  const spec: CommandSpec = {
    args: [
      { kind: 'string', optional: false },
      { kind: 'number', optional: true },
    ],
  };
  checkArgs('c', spec, ['a']);
  checkArgs('c', spec, ['a', 2]);
  assert.throws(() => checkArgs('c', spec, []), { code: 'Invalid', message: 'c: аргументов 0, ожидается 1-2' });
  assert.throws(() => checkArgs('c', spec, ['a', 2, 3]), { code: 'Invalid' });
  assert.throws(() => checkArgs('c', spec, [1]), { code: 'Invalid', message: 'c: аргумент 1 не string' });
  assert.throws(() => checkArgs('c', spec, ['a', Number.NaN]), { message: 'c: аргумент 2 не number' });

  const rest: CommandSpec = { args: [{ kind: 'string', optional: false }], rest: 'record' };
  checkArgs('r', rest, ['a', {}, {}]);
  assert.throws(() => checkArgs('r', rest, ['a', {}, []]), { message: 'r: аргумент 3 не record' });
  assert.throws(() => checkArgs('r', { args: [{ kind: 'any', optional: false }] }, [undefined]), { message: 'r: аргумент 1 не any' });
});

// K-03: род области (area), order и заголовок вида; area и order типа документа. Строка "./ui.js" остаётся краткой записью.
const uiErrors = (ui: unknown) => {
  const r = parseManifest({ ...base, ui });
  return r.ok ? [] : r.errors;
};
const docErrors = (documents: unknown) => {
  const r = parseManifest({ ...base, documents });
  return r.ok ? [] : r.errors;
};
const AREAS = 'sidebar, main, toolbar или popup';

test('вид: объект с module, area, order и title; строка остаётся краткой записью и не получает размещения', () => {
  const r = parseManifest({
    ...base,
    ui: { views: { sessions: { module: './ui/s.js', area: 'main', order: 100, title: 'Сессии' }, tree: './ui/tree.js', bar: { module: './bar.js' } } },
  });
  assert.ok(r.ok);
  const { views, placement } = r.manifest.ui ?? {};
  assert.deepEqual(views, { sessions: './ui/s.js', tree: './ui/tree.js', bar: './bar.js' });
  assert.deepEqual(placement, { sessions: { area: 'main', order: 100, title: 'Сессии' } });
  const short = parseManifest({ ...base, ui: { views: { tree: './ui/tree.js' } } });
  assert.ok(short.ok);
  assert.equal(short.manifest.ui?.placement, undefined, 'старая форма манифеста не получает новых полей');
});

test('вид: неизвестная область и нечисловой order - отказ с именем поля', () => {
  assert.deepEqual(uiErrors({ views: { a: { module: './a.js', area: 'basement' } } }), [`ui.views.a.area: ожидается ${AREAS}, получено "basement"`]);
  assert.deepEqual(uiErrors({ views: { a: { module: './a.js', area: 7 } } }), [`ui.views.a.area: ожидается ${AREAS}, получено 7`]);
  assert.deepEqual(uiErrors({ views: { a: { module: './a.js', order: '100' } } }), ['ui.views.a.order: ожидается число, получено "100"']);
  assert.deepEqual(uiErrors({ views: { a: { module: './a.js', order: null } } }), ['ui.views.a.order: ожидается число, получено null']);
  assert.equal(uiErrors({ views: { a: { module: './a.js', order: Number.POSITIVE_INFINITY } } }).length, 1, 'бесконечность - не порядок');
  assert.match(uiErrors({ views: { a: { module: './a.js', area: 'overlay' } } }).join(), /^ui\.views\.a\.area:.*ui\.overlay/);
});

test('вид: у объекта module обязателен, лишнее поле и неверный заголовок - отказ, ошибки пути прежние', () => {
  const entry = 'ожидается путь "./<модуль>.js" внутри каталога плагина';
  assert.deepEqual(uiErrors({ views: { a: { area: 'main' } } }), [`ui.views.a.module: ${entry}, получено ничего`]);
  assert.deepEqual(uiErrors({ views: { a: { module: '../a.js' } } }), [`ui.views.a.module: ${entry}, получено "../a.js"`]);
  assert.deepEqual(uiErrors({ views: { a: './../a.js' } }), [`ui.views.a: ${entry}, получено "./../a.js"`]);
  assert.deepEqual(uiErrors({ views: { a: { module: './a.js', colour: 'red' } } }), ['ui.views.a.colour: незнакомое поле вида']);
  assert.deepEqual(uiErrors({ views: { a: { module: './a.js', title: '' } } }), ['ui.views.a.title: ожидается непустая строка до 80 символов, получено ""']);
  assert.equal(uiErrors({ views: { a: { module: './a.js', title: 'x'.repeat(81) } } }).length, 1);
  assert.deepEqual(uiErrors({ views: { a: 7 } }), [`ui.views.a: ${entry} или объект { module, area?, order?, title? }, получено 7`]);
});

// K-04: ui.group - рекомендация автора о группе рендера (один origin и процесс на группу); решает ядро с plugins.uiGroups.
test('ui.group: имя группы в манифесте разбирается, без поля его нет, ошибка называет поле', () => {
  const ok = parseManifest({ ...base, ui: { views: { main: './ui.js' }, group: 'cyborg.panels' } });
  assert.ok(ok.ok);
  assert.equal(ok.manifest.ui?.group, 'cyborg.panels');
  const overlayOnly = parseManifest({ ...base, permissions: { 'ui.lock': true }, ui: { overlay: './lock.js', group: 'locks' } });
  assert.ok(overlayOnly.ok && overlayOnly.manifest.ui?.group === 'locks');
  const without = parseManifest({ ...base, ui: { views: { main: './ui.js' } } });
  assert.ok(without.ok);
  assert.equal(without.manifest.ui?.group, undefined, 'старая форма манифеста не получает новых полей');
  const group = 'ожидается имя группы: строчные латинские буквы, цифры и дефис, части через точку';
  for (const bad of ['Panels', '', 'a b', 'a/b', '.a', 'a..b', '1a', 'a:80', '../x'])
    assert.deepEqual(uiErrors({ views: { a: './a.js' }, group: bad }), [`ui.group: ${group}, получено ${JSON.stringify(bad)}`], bad);
  assert.deepEqual(uiErrors({ views: { a: './a.js' }, group: 7 }), [`ui.group: ${group}, получено 7`]);
  assert.deepEqual(uiErrors({ views: { a: './a.js' }, group: null }), [`ui.group: ${group}, получено null`]);
  assert.match(uiErrors({ group: 'panels' }).join(), /^ui: ожидается/, 'группа без видов и экрана замка - не ui');
  assert.deepEqual(uiErrors({ views: { a: './a.js' }, groups: 'x' }), ['ui.groups: ядро знает только ui.views, ui.overlay, ui.group и ui.inlineStyles']);
});

// K-05: ui.inlineStyles - только true включает инлайн-стили вида; без поля, как и с false, поля в разборе нет.
test('ui.inlineStyles: только булев true включает инлайн-стили вида, прочее - отказ с именем поля', () => {
  const ok = parseManifest({ ...base, ui: { views: { main: './ui.js' }, inlineStyles: true } });
  assert.ok(ok.ok);
  assert.equal(ok.manifest.ui?.inlineStyles, true);
  const off = parseManifest({ ...base, ui: { views: { main: './ui.js' }, inlineStyles: false } });
  assert.ok(off.ok);
  assert.equal(off.manifest.ui?.inlineStyles, undefined, 'false - то же, что без поля: в разборе его нет');
  const without = parseManifest({ ...base, ui: { views: { main: './ui.js' } } });
  assert.ok(without.ok);
  assert.equal(without.manifest.ui?.inlineStyles, undefined, 'старая форма манифеста не получает новых полей');
  const overlayOnly = parseManifest({ ...base, permissions: { 'ui.lock': true }, ui: { overlay: './lock.js', inlineStyles: true } });
  assert.ok(overlayOnly.ok && overlayOnly.manifest.ui?.inlineStyles === true, 'экран замка тоже вид: флаг действует и на него');
  for (const bad of ['true', 1, null, 'yes', {}])
    assert.deepEqual(uiErrors({ views: { a: './a.js' }, inlineStyles: bad }), [`ui.inlineStyles: ожидается true или false, получено ${JSON.stringify(bad)}`], JSON.stringify(bad));
  assert.deepEqual(uiErrors({ views: { a: './a.js' }, inlineStyle: true }), ['ui.inlineStyle: ядро знает только ui.views, ui.overlay, ui.group и ui.inlineStyles']);
});

test('документ: area и order типа; короткая запись прежняя, ошибка называет поле', () => {
  const ok = parseManifest({ ...base, documents: { note: { restorable: true, area: 'main', order: 200 }, plain: {} } });
  assert.ok(ok.ok);
  assert.deepEqual(ok.manifest.documents, { note: { restorable: true, area: 'main', order: 200 }, plain: { restorable: false } });
  assert.deepEqual(docErrors({ note: { area: 'cellar' } }), [`documents.note.area: ожидается ${AREAS}, получено "cellar"`]);
  assert.deepEqual(docErrors({ note: { order: 'first' } }), ['documents.note.order: ожидается число, получено "first"']);
  assert.deepEqual(docErrors({ note: { colour: 1 } }), ['documents.note.colour: незнакомое поле типа документа']);
  assert.deepEqual(docErrors({ note: { restorable: 'yes' } }), ['documents.note.restorable: ожидается true или false, получено "yes"']);
  assert.deepEqual(docErrors({ note: true }), ['documents.note: ожидается объект { "restorable": true, "area"?, "order"? }, получено true']);
});

test('манифест: deprecated у provides - члены с пометкой @deprecated, ошибки называют поле', () => {
  const ok = parseManifest({ ...base, provides: { 'test.old': { version: ['1.4', '2.0'], deprecated: ['list', 'get_one'], guard: { list: { 'fs.read': 0 } } }, 'test.new': '1.0' } });
  assert.ok(ok.ok);
  assert.deepEqual(ok.manifest.deprecated, { 'test.old': ['list', 'get_one'] });
  assert.deepEqual(ok.manifest.provides, { 'test.old': ['1.4', '2.0'], 'test.new': ['1.0'] });
  const none = parseManifest({ ...base, provides: { 'test.old': { version: '1.0', deprecated: [] }, 'test.new': '1.0' } });
  assert.ok(none.ok);
  assert.equal(none.manifest.deprecated, undefined, 'пустой список - пометок нет');

  const notList = parseManifest({ ...base, provides: { 'test.old': { version: '1.0', deprecated: 'list' } } });
  assert.deepEqual(notList, { ok: false, id: 'pin-lock', errors: ['provides.test.old.deprecated: ожидается список имён членов, получено "list"'] });

  const bad = parseManifest({ ...base, provides: { 'test.old': { version: '1.0', deprecated: ['list', 7, 'a b', '', 'list', 'x.y'] } } });
  assert.ok(!bad.ok);
  assert.deepEqual(bad.errors, [
    'provides.test.old.deprecated[1]: ожидается имя члена контракта строкой, получено 7',
    'provides.test.old.deprecated[2]: ожидается имя члена контракта строкой, получено "a b"',
    'provides.test.old.deprecated[3]: ожидается имя члена контракта строкой, получено ""',
    'provides.test.old.deprecated[4]: "list" уже в списке',
    'provides.test.old.deprecated[5]: ожидается имя члена контракта строкой, получено "x.y"',
  ]);
});

// K-08: вклады плагина в меню окна (`contributes.menus`). Ошибки называют поле целиком; команда и источник состояния должны принадлежать плагину.
const menuBase = {
  ...base,
  commands: ['pin-lock.lock', 'pin-lock.status'],
  provides: { 'cyborg.lock': '1.2' },
  optional: { 'cyborg.projects': '^1.3' },
  consumes: { 'cyborg.tools': '^1' },
};
const menuItem = { id: 'lock', menu: 'view', title: 'Заблокировать', command: 'pin-lock.lock' };
const menuErrors = (menus: unknown, extra: Record<string, unknown> = {}) => {
  const r = parseManifest({ ...menuBase, ...extra, contributes: { menus } });
  return r.ok ? [] : r.errors;
};

test('contributes.menus: пункт приводится к полной форме, источники enabled и checked - член контракта', () => {
  const r = parseManifest({
    ...menuBase,
    contributes: {
      menus: [
        { ...menuItem, order: 300, accelerator: 'cmd+shift+l', enabled: { contract: 'cyborg.projects', major: 1, member: 'hasCurrent' }, checked: { contract: 'cyborg.lock', major: 1, member: 'isLocked' } },
        { id: 'status', menu: 'tools', title: 'Состояние', command: 'pin-lock.status' },
      ],
    },
  });
  assert.ok(r.ok);
  assert.deepEqual(r.manifest.contributes?.menus, [
    {
      id: 'lock',
      menu: 'view',
      title: 'Заблокировать',
      command: 'pin-lock.lock',
      order: 300,
      accelerator: 'Shift+Meta+L',
      enabled: { contract: 'cyborg.projects', major: 1, member: 'hasCurrent' },
      checked: { contract: 'cyborg.lock', major: 1, member: 'isLocked' },
    },
    { id: 'status', menu: 'tools', title: 'Состояние', command: 'pin-lock.status' },
  ]);
  const plain = parseManifest(menuBase);
  assert.ok(plain.ok);
  assert.equal(plain.manifest.contributes, undefined, 'манифест без вкладов не получает новых полей');
});

test('contributes: незнакомое поле, не объект и не список - отказ с именем поля', () => {
  const unknown = parseManifest({ ...menuBase, contributes: { menus: [menuItem], toolbar: [] } });
  assert.deepEqual(unknown, { ok: false, id: 'pin-lock', errors: ['contributes.toolbar: ядро знает только contributes.menus'] });
  assert.deepEqual(parseManifest({ ...menuBase, contributes: [] }), { ok: false, id: 'pin-lock', errors: ['contributes: ожидается { "menus": [...] }, получено []'] });
  assert.deepEqual(menuErrors({ view: [menuItem] }), ['contributes.menus: ожидается список пунктов { id, menu, title, command, ... }, получено {"view":[{"id":"lock","menu":"view","title":"Заблокировать","command":"pin-lock.lock"}]}']);
  assert.deepEqual(menuErrors([]), ['contributes.menus: нет ни одного пункта']);
  assert.deepEqual(menuErrors([7]), ['contributes.menus[0]: ожидается объект { id, menu, title, command, ... }, получено 7']);
});

test('contributes.menus: неизвестное поле пункта, меню не из списка ядра, пустой и длинный заголовок - отказ с именем поля', () => {
  assert.deepEqual(menuErrors([{ ...menuItem, icon: 'lock' }]), ['contributes.menus.lock.icon: незнакомое поле пункта меню']);
  assert.deepEqual(menuErrors([{ ...menuItem, menu: 'edit' }]), ['contributes.menus.lock.menu: ожидается workspace, view, tools или window, получено "edit"']);
  assert.deepEqual(menuErrors([{ ...menuItem, menu: undefined }]), ['contributes.menus.lock.menu: ожидается workspace, view, tools или window, получено ничего']);
  assert.deepEqual(menuErrors([{ ...menuItem, title: '' }]), ['contributes.menus.lock.title: ожидается непустая строка до 80 символов, получено ""']);
  assert.equal(menuErrors([{ ...menuItem, title: 'x'.repeat(81) }]).length, 1);
  assert.deepEqual(menuErrors([{ ...menuItem, order: '1' }]), ['contributes.menus.lock.order: ожидается число, получено "1"']);
  assert.deepEqual(menuErrors([{ ...menuItem, id: 'Bad Id' }]), ['contributes.menus[0].id: ожидается имя вида "open" (строчные латинские буквы, цифры и дефис), получено "Bad Id"']);
  assert.deepEqual(menuErrors([menuItem, menuItem]), ['contributes.menus.lock: id повторяется']);
  const many = Array.from({ length: 33 }, (_, i) => ({ ...menuItem, id: `item-${String(i)}` }));
  assert.deepEqual(menuErrors(many), ['contributes.menus: не больше 32 пунктов']);
});

test('contributes.menus: команда должна принадлежать плагину и не требовать аргументов', () => {
  assert.deepEqual(menuErrors([{ ...menuItem, command: 'other.lock' }]), ['contributes.menus.lock.command: команда "other.lock" не объявлена в commands этого плагина']);
  assert.deepEqual(menuErrors([{ ...menuItem, command: undefined }]), ['contributes.menus.lock.command: команда ничего не объявлена в commands этого плагина']);
  assert.deepEqual(menuErrors([menuItem], { commands: { 'pin-lock.lock': { args: ['string'] } } }), ['contributes.menus.lock.command: у pin-lock.lock обязательные аргументы, пункт меню их не даст']);
  assert.ok(parseManifest({ ...menuBase, commands: { 'pin-lock.lock': { args: ['string?'] } }, contributes: { menus: [menuItem] } }).ok);
});

test('contributes.menus: сочетание пункта разбирается как в keybindings и не повторяется в плагине', () => {
  assert.deepEqual(menuErrors([{ ...menuItem, accelerator: 'Ctrl+Hyper+L' }]), ['contributes.menus.lock.accelerator: сочетание "Ctrl+Hyper+L" не разобрано, ожидается вида "CmdOrCtrl+Shift+K" или "F5"']);
  assert.deepEqual(menuErrors([{ ...menuItem, accelerator: 'L' }]), ['contributes.menus.lock.accelerator: сочетание "L" не разобрано, ожидается вида "CmdOrCtrl+Shift+K" или "F5"']);
  const twice = menuErrors([
    { ...menuItem, accelerator: 'CmdOrCtrl+L' },
    { id: 'status', menu: 'tools', title: 'Состояние', command: 'pin-lock.status', accelerator: 'cmdorctrl+l' },
  ]);
  assert.deepEqual(twice, ['contributes.menus.status.accelerator: сочетание CmdOrCtrl+L уже у пункта lock']);
});

test('contributes.menus: источник состояния - член контракта из requires, optional или provides этого плагина', () => {
  const at = (field: 'enabled' | 'checked', source: unknown, extra: Record<string, unknown> = {}) => menuErrors([{ ...menuItem, [field]: source }], extra);
  assert.deepEqual(at('enabled', true), ['contributes.menus.lock.enabled: ожидается { contract, major, member }, получено true']);
  assert.deepEqual(at('checked', { contract: 'cyborg.projects', major: 1 }), ['contributes.menus.lock.checked.member: ожидается имя члена контракта строкой, получено ничего']);
  assert.deepEqual(at('enabled', { contract: 'cyborg.projects', major: 1.5, member: 'x' }), ['contributes.menus.lock.enabled.major: ожидается целое >= 0, получено 1.5']);
  assert.deepEqual(at('enabled', { contract: 'Bad', major: 1, member: 'x' }), ['contributes.menus.lock.enabled.contract: ожидается имя контракта, получено "Bad"']);
  assert.deepEqual(at('enabled', { contract: 'cyborg.projects', major: 1, member: 'x', extra: 1 }), ['contributes.menus.lock.enabled.extra: незнакомое поле источника']);
  assert.deepEqual(at('enabled', { contract: 'cyborg.other', major: 1, member: 'x' }), ['contributes.menus.lock.enabled.contract: cyborg.other нет в requires, optional и provides этого плагина (consumes не годится: поставщиков несколько)']);
  assert.deepEqual(at('enabled', { contract: 'cyborg.tools', major: 1, member: 'x' }), ['contributes.menus.lock.enabled.contract: cyborg.tools нет в requires, optional и provides этого плагина (consumes не годится: поставщиков несколько)']);
  assert.deepEqual(at('checked', { contract: 'cyborg.projects', major: 2, member: 'x' }), ['contributes.menus.lock.checked.major: у cyborg.projects в optional "^1.3" нет мажорной версии 2']);
  assert.deepEqual(at('checked', { contract: 'cyborg.lock', major: 2, member: 'x' }), ['contributes.menus.lock.checked.major: плагин отдаёт cyborg.lock только мажорных версий 1']);
});

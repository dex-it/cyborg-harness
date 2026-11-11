// Перенос настроек окна Cyborg из localStorage в память видов (PL-06). Чистый модуль без DOM и Node: его читают и главная часть, и вид.
// Старое окно (ai-cyborg, коммит e4beb72) хранит 10 ключей `cyborg.*` и 3 семейства строк (`prefs.ts` окна); прочитать их может только оно,
// поэтому оно отдаёт плагину все ключи `cyborg.*` как есть (строка -> строка), а плагин раскладывает их по видам будущих владельцев.
// Таблица «ключ - вид - поле» и решения - docs/05-verification/pilot-legacy-data.md.

/** Предел памяти вида (`ctx.state.set`): 64 КБ JSON; запас оставлен под метку `legacyImported`. */
export const VIEW_MEMORY_MAX = 64 * 1024;
const BUDGET = VIEW_MEMORY_MAX - 1024;

/** Метка в памяти вида: перенос уже сделан, повторная отдача настроек старым окном их не перезапишет. */
export const IMPORTED = 'legacyImported';

export interface SkippedPref {
  readonly key: string;
  readonly reason: string;
}

export interface LegacyPrefs {
  /** Вид -> его новая память (без метки). */
  readonly views: Readonly<Record<string, Record<string, unknown>>>;
  /** Ключи `cyborg.*`, которые не перенесены, и почему: ничего не пропадает молча. */
  readonly skipped: readonly SkippedPref[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type Parsed = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string };
const ok = (value: unknown): Parsed => ({ ok: true, value });
const bad = (reason: string): Parsed => ({ ok: false, reason });

/** Выбор из списка допустимых значений проверяет владелец вида, как проверял `readChoice` окна; здесь только непустая строка. */
const choice = (raw: string): Parsed => (raw === '' ? bad('пустое значение') : ok(raw));
const flag = (raw: string): Parsed => (raw === '1' ? ok(true) : raw === '0' ? ok(false) : bad('ожидается 1 или 0'));

function fontSize(raw: string): Parsed {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 8 && n <= 32 ? ok(n) : bad('ожидается целое от 8 до 32');
}

/** `ширина,высота` в пикселях; пустая строка - окно сбросило размер, переносить нечего. */
function size(raw: string): Parsed {
  const [w, h, ...extra] = raw.split(',').map(Number);
  return w !== undefined && h !== undefined && extra.length === 0 && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 ? ok({ width: w, height: h }) : bad('ожидается «ширина,высота»');
}

/** Фильтр меток `[[имя, '+'|'-'], ...]` как его пишет `serializeLabelFilter`; повреждённое значение целиком окно читало как пустой фильтр. */
function labels(raw: string): Parsed {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return bad('не JSON');
  }
  const valid = Array.isArray(data) && data.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && pair[0] !== '' && (pair[1] === '+' || pair[1] === '-'));
  return valid ? ok(data) : bad('ожидается список пар [имя, "+" или "-"]');
}

interface Target {
  readonly view: string;
  readonly field: string;
  readonly parse: (raw: string) => Parsed;
}

/** Десять ключей. */
const KEYS: Readonly<Record<string, Target>> = {
  'cyborg.fontSize': { view: 'terminal', field: 'fontSize', parse: fontSize },
  // Окно включало уведомления для любого значения, кроме 'off'.
  'cyborg.notifications': { view: 'notifications', field: 'enabled', parse: (raw) => ok(raw !== 'off') },
  'cyborg.tasks.assigned': { view: 'tasks', field: 'assigned', parse: flag },
  'cyborg.tasks.sort': { view: 'tasks', field: 'sort', parse: choice },
  'cyborg.mrs.filter': { view: 'mrs', field: 'filter', parse: choice },
  'cyborg.mrs.sort': { view: 'mrs', field: 'sort', parse: choice },
  'cyborg.search.mode': { view: 'search', field: 'mode', parse: choice },
  'cyborg.extensions.tab': { view: 'extensions', field: 'tab', parse: choice },
  'cyborg.extensions.view': { view: 'extensions', field: 'view', parse: choice },
  'cyborg.extensions.size': { view: 'extensions', field: 'size', parse: size },
};

/** Семейства `cyborg.search.<флаг>` и `cyborg.extensions.<флаг>`: флаги окон поиска и «Расширений». */
const FLAGS: Readonly<Record<string, readonly string[]>> = {
  'cyborg.search.': ['regex', 'caseSensitive', 'wholeWord'],
  'cyborg.extensions.': ['regex', 'caseSensitive'],
};
const LABELS_PREFIX = 'cyborg.tasks.labels:';

/** Раскладывает ключи `cyborg.*` старого окна по видам. Чужие ключи (не `cyborg.`) не трогаются и не перечисляются. */
export function readLegacyPrefs(dump: unknown): LegacyPrefs {
  const views: Record<string, Record<string, unknown>> = {};
  const skipped: SkippedPref[] = [];
  const labelsFor: [string, unknown][] = [];
  const slot = (view: string): Record<string, unknown> => (views[view] ??= {});
  const put = (view: string, field: string, value: unknown) => (slot(view)[field] = value);
  for (const key of Object.keys(isRecord(dump) ? dump : {}).sort()) {
    if (!key.startsWith('cyborg.')) continue;
    const raw = (dump as Record<string, unknown>)[key];
    const skip = (reason: string) => skipped.push({ key, reason });
    if (typeof raw !== 'string') {
      skip('значение не строка');
      continue;
    }
    const target = KEYS[key];
    if (target) {
      // Пустой размер окна «Расширений» - сброс на умолчание: переносить нечего.
      if (key === 'cyborg.extensions.size' && raw === '') continue;
      const parsed = target.parse(raw);
      if (parsed.ok) put(target.view, target.field, parsed.value);
      else skip(parsed.reason);
      continue;
    }
    if (key.startsWith(LABELS_PREFIX)) {
      const id = key.slice(LABELS_PREFIX.length);
      const parsed = id === '' ? bad('нет id проекта') : labels(raw);
      if (parsed.ok) labelsFor.push([id, parsed.value]);
      else skip(parsed.reason);
      continue;
    }
    const family = Object.keys(FLAGS).find((prefix) => key.startsWith(prefix));
    const name = family === undefined ? undefined : key.slice(family.length);
    if (family !== undefined && name !== undefined && FLAGS[family]?.includes(name)) {
      const parsed = flag(raw);
      if (parsed.ok) put(family === 'cyborg.search.' ? 'search' : 'extensions', name, parsed.value);
      else skip(parsed.reason);
      continue;
    }
    skip('ключа нет в списке окна e4beb72');
  }
  // Фильтры меток растут с числом проектов; память вида ограничена, поэтому лишнее не пропадает молча, а названо.
  for (const [id, value] of labelsFor) {
    const tasks = slot('tasks');
    const next = { ...(isRecord(tasks.labels) ? tasks.labels : {}), [id]: value };
    if (new TextEncoder().encode(JSON.stringify({ ...tasks, labels: next })).length > BUDGET) skipped.push({ key: `${LABELS_PREFIX}${id}`, reason: 'память вида больше 64 КБ' });
    else tasks.labels = next;
  }
  return { views, skipped };
}

/**
 * Новая память вида после переноса. Метка уже стоит - `undefined`, писать нечего. Иначе значение, которое человек уже успел задать в новом окне,
 * сильнее перенесённого; вложенные записи (метки по проектам, размер) сливаются так же, поле за полем.
 */
export function mergeLegacy(current: unknown, incoming: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const own = isRecord(current) ? current : {};
  if (own[IMPORTED] === true) return undefined;
  const merged: Record<string, unknown> = { ...incoming };
  for (const [field, value] of Object.entries(own)) {
    const inc = merged[field];
    merged[field] = isRecord(value) && isRecord(inc) ? { ...inc, ...value } : value;
  }
  merged[IMPORTED] = true;
  return merged;
}

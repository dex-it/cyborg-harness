/** Замечание владельца к тексту: позиции с единицы, как у маркеров Monaco. */
export interface Problem {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

const THEMES = ['light', 'dark'];
const FIELDS = ['fontSize', 'theme', 'keys'];

/** Строка и столбец первого вхождения `"ключ"`; ключа нет - начало файла. */
function where(text: string, key: string): { line: number; column: number } {
  const at = text.indexOf(`"${key}"`);
  if (at < 0) return { line: 1, column: 1 };
  const before = text.slice(0, at).split('\n');
  return { line: before.length, column: (before.at(-1) ?? '').length + 1 };
}

/** Схема настроек плагина: `fontSize` 8-32, `theme` light или dark, `keys` - массив строк. Синтаксис JSON показывает сам редактор; здесь он лишь не даёт упасть. */
export function checkSettings(text: string): Problem[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ line: 1, column: 1, message: 'настройки - объект' }];
  const settings = value as Record<string, unknown>;
  const problems: Problem[] = [];
  const add = (key: string, message: string) => problems.push({ ...where(text, key), message });
  const { fontSize, theme, keys } = settings;
  if (typeof fontSize !== 'number' || fontSize < 8 || fontSize > 32) add('fontSize', 'fontSize - число от 8 до 32');
  if (typeof theme !== 'string' || !THEMES.includes(theme)) add('theme', `theme - одна из: ${THEMES.join(', ')}`);
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) add('keys', 'keys - массив строк');
  for (const key of Object.keys(settings)) if (!FIELDS.includes(key)) add(key, `неизвестное поле ${key}`);
  return problems;
}

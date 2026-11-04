export type Version = readonly [number, number, number];

interface Bounds {
  readonly min: Version;
  /** Верхняя граница не включается; `null` - без границы. */
  readonly max: Version | null;
}

const VERSION = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?$/;

/** `1`, `1.2` и `1.2.3`; недостающие части - нули. */
export function parseVersion(text: string): Version | null {
  const m = VERSION.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Диапазон: `*`, версия-префикс (`1`, `1.2`, `1.2.3`), `^` и `~` по правилам npm. */
export function isValidRange(range: string): boolean {
  return toBounds(range) !== null;
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const b = toBounds(range);
  if (!v || !b) return false;
  return compareVersions(v, b.min) >= 0 && (b.max === null || compareVersions(v, b.max) < 0);
}

function toBounds(range: string): Bounds | null {
  const r = range.trim();
  if (r === '*') return { min: [0, 0, 0], max: null };
  const op = r.startsWith('^') || r.startsWith('~') ? r[0] : '';
  const body = op ? r.slice(1) : r;
  const m = VERSION.exec(body);
  if (!m) return null;
  const parts = m[3] !== undefined ? 3 : m[2] !== undefined ? 2 : 1;
  const min = parseVersion(body)!;
  const [major, minor, patch] = min;
  if (op === '^') {
    if (major > 0 || parts === 1) return { min, max: [major + 1, 0, 0] };
    if (minor > 0 || parts === 2) return { min, max: [0, minor + 1, 0] };
    return { min, max: [0, 0, patch + 1] };
  }
  if (op === '~') {
    return parts === 1 ? { min, max: [major + 1, 0, 0] } : { min, max: [major, minor + 1, 0] };
  }
  if (parts === 1) return { min, max: [major + 1, 0, 0] };
  if (parts === 2) return { min, max: [major, minor + 1, 0] };
  return { min, max: [major, minor, patch + 1] };
}

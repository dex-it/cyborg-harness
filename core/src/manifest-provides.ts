import { isValidId, show } from './manifest-fields.ts';
import { parseVersion } from './semver.ts';
import { readGuard, type MemberGuards } from './via-contract.ts';
import { isRecord } from './wire.ts';

export interface Provides {
  readonly provides: Record<string, string[]>;
  readonly guards?: Record<string, MemberGuards>;
}

/** Значение - версия, список версий или `{ version, guard? }`. */
export function readProvides(raw: unknown, errors: string[]): Provides {
  const out: Record<string, string[]> = {};
  const guards: Record<string, MemberGuards> = {};
  if (raw === undefined) return { provides: out };
  if (!isRecord(raw)) {
    errors.push('provides: ожидается объект');
    return { provides: out };
  }
  for (const [name, entry] of Object.entries(raw)) {
    if (!isValidId(name)) errors.push(`provides.${name}: недопустимое имя контракта`);
    const full = isRecord(entry) ? entry : undefined;
    for (const key of Object.keys(full ?? {})) if (!['version', 'guard'].includes(key)) errors.push(`provides.${name}.${key}: неизвестное поле`);
    const guard = readGuard(`provides.${name}.guard`, full?.guard, errors);
    if (guard) guards[name] = guard;
    const value = full ? full.version : entry;
    const list: unknown = typeof value === 'string' ? [value] : value;
    const versions = Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string' && parseVersion(v) !== null) : [];
    if (!Array.isArray(list) || versions.length === 0 || versions.length !== list.length) {
      errors.push(`provides.${name}: ожидается версия или список версий, получено ${show(value)}`);
      continue;
    }
    const majors = versions.map((v) => parseVersion(v)?.[0]);
    if (new Set(majors).size !== majors.length) errors.push(`provides.${name}: две версии одной мажорной`);
    out[name] = versions;
  }
  return { provides: out, ...(Object.keys(guards).length > 0 && { guards }) };
}

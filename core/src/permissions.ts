import type { PluginPermissions } from '@cyborg/contracts';
import { isRecord } from './wire.ts';

export type { PluginPermissions };

export const AREAS = ['workspace', 'plugin-data', 'plugin-temp'] as const;

const KEYS = ['fs.read', 'fs.write', 'process', 'pty', 'net', 'env', 'notify', 'clipboard', 'secrets.ref', 'security.roots', 'ui.lock'] as const;

const isArea = (v: string) => (AREAS as readonly string[]).includes(v) || v.startsWith('/') || v === '~' || v.startsWith('~/');
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Программа правила `process` и `pty`: оболочка входа человека; ядро подставляет её путь само. */
export const LOGIN_SHELL = '$SHELL';
const HOST = /^(?:config:[A-Za-z][\w.]*|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?)$/i;

function strings(field: string, raw: unknown, errors: string[], ok: (v: string) => boolean, expected: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((v): v is string => typeof v === 'string' && ok(v))) {
    errors.push(`permissions.${field}: ожидается список - ${expected}`);
    return undefined;
  }
  return [...new Set(raw)];
}

/** Права из манифеста; неизвестное право - ошибка манифеста, а не молчаливое «нет права». */
export function readPermissions(raw: unknown, errors: string[]): PluginPermissions {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    errors.push('permissions: ожидается объект');
    return {};
  }
  for (const key of Object.keys(raw)) if (!(KEYS as readonly string[]).includes(key)) errors.push(`permissions.${key}: неизвестное право`);
  const out: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined) out[key] = value;
  };
  const areas = `области ${AREAS.join(', ')} или абсолютные пути`;
  set('fs.read', strings('fs.read', raw['fs.read'], errors, isArea, areas));
  set('fs.write', strings('fs.write', raw['fs.write'], errors, isArea, areas));
  set('net', strings('net', raw.net, errors, (v) => HOST.test(v), 'хосты или config:<поле>'));
  set('env', strings('env', raw.env, errors, (v) => ENV_NAME.test(v), 'имена переменных'));
  set('secrets.ref', strings('secrets.ref', raw['secrets.ref'], errors, (v) => /^[a-z][a-z0-9+.-]*:\/\/./.test(v), 'маски ссылок со схемой'));
  set('clipboard', strings('clipboard', raw.clipboard, errors, (v) => v === 'read' || v === 'write', 'read, write'));
  for (const flag of ['notify', 'security.roots', 'ui.lock'] as const) {
    if (raw[flag] === undefined) continue;
    if (typeof raw[flag] !== 'boolean') errors.push(`permissions.${flag}: ожидается true или false`);
    else if (raw[flag]) set(flag, true);
  }
  for (const key of ['process', 'pty'] as const) {
    if (raw[key] === undefined) continue;
    const rules = Array.isArray(raw[key]) ? raw[key] : undefined;
    const ok = rules?.every(
      (r) =>
        (typeof r === 'string' && r.length > 0 && r !== LOGIN_SHELL) ||
        (isRecord(r) &&
          typeof r.program === 'string' &&
          r.program.length > 0 &&
          Array.isArray(r.args) &&
          // Оболочка без закреплённого скрипта (`-lc` и текст) запустила бы что угодно.
          (r.program !== LOGIN_SHELL || r.args.length >= 2) &&
          r.args.every((a) => typeof a === 'string') &&
          (r.env === undefined || (Array.isArray(r.env) && r.env.every((v) => typeof v === 'string' && ENV_NAME.test(v))))),
    );
    if (!ok) errors.push(`permissions.${key}: ожидается список программ или {program, args, env?}; ${LOGIN_SHELL} - только с флагом и скриптом в args`);
    else set(key, rules);
  }
  return out;
}

const AREA_WORDS: Readonly<Record<string, string>> = { workspace: 'проекты воркспейса', 'plugin-data': 'свои данные', 'plugin-temp': 'свой временный каталог' };
const areaWords = (areas: readonly string[]) => areas.map((a) => AREA_WORDS[a] ?? a).join(', ');

/** Права словами: те же строки покажет окно согласия второго этапа. */
export function describePermissions(p: PluginPermissions): string[] {
  const out: string[] = [];
  if (p['fs.read']) out.push(`читает файлы: ${areaWords(p['fs.read'])}`);
  if (p['fs.write']) out.push(`пишет файлы: ${areaWords(p['fs.write'])}`);
  const program = (p: string) => (p === LOGIN_SHELL ? 'оболочка входа' : p);
  const programs = (rules: PluginPermissions['process']) => (rules ?? []).map((r) => (typeof r === 'string' ? r : [program(r.program), ...r.args].join(' ') + (r.env?.length ? ` (окружение: ${r.env.join(', ')})` : ''))).join(', ');
  if (p.process) out.push(`запускает программы: ${programs(p.process)} - полный доступ через программу`);
  if (p.pty) out.push(`запускает в терминале: ${programs(p.pty)} - полный доступ через программу`);
  if (p.net) out.push(`ходит в сеть: ${p.net.map((h) => (h.startsWith('config:') ? `хост из настройки ${h.slice('config:'.length)}` : h)).join(', ')}`);
  if (p.env) out.push(`читает переменные окружения: ${p.env.join(', ')}`);
  if (p.notify) out.push('показывает системные уведомления');
  if (p.clipboard) out.push(`буфер обмена: ${p.clipboard.map((c) => (c === 'read' ? 'чтение' : 'запись')).join(', ')}`);
  if (p['secrets.ref']) out.push(`читает секреты ${p['secrets.ref'].join(', ')}`);
  if (p['security.roots']) out.push('задаёт корни проектов, доступные другим плагинам');
  if (p['ui.lock']) out.push('может закрыть окно Cyborg');
  return out;
}

import type { PluginPermissions } from '@cyborg-harness/contracts';
import { isRecord } from './wire.ts';

export type { PluginPermissions };

export const AREAS = ['workspace', 'plugin-data', 'plugin-temp', 'granted'] as const;

/** Права, которые знает разбор манифеста; по ним тест сверяет схему манифеста (`contracts/manifest.schema.json`). */
export const PERMISSION_KEYS = ['fs.read', 'fs.write', 'shell', 'process', 'pty', 'launch', 'net', 'env', 'notify', 'clipboard', 'secrets.ref', 'security.roots', 'ui.lock', 'serve'] as const;

const isPath = (v: string) => {
  if (!(v.startsWith('/') || v === '~' || v.startsWith('~/'))) return false;
  const parts = v.split('/').slice(1);
  if (parts.some((s) => s === '.' || s === '..')) return false;
  // Маска держится за названный каталог: `/*` или `~/*` открыли бы всё.
  return !parts[0]?.includes('*') && parts.every((s) => s === '**' || !s.includes('**'));
};
const isArea = (v: string) => (AREAS as readonly string[]).includes(v) || isPath(v);
const isWriteArea = (v: string) => v === 'workspace.git' || isArea(v);
/** Область только права `shell`: любой существующий документ или каталог, как ссылка из вывода сессии. Читать и писать там она не даёт. */
export const ANY_PATH = 'any';
// file: открыл бы путь мимо проверки областей, javascript: и data: - не адрес.
const isScheme = (v: string) => /^[a-z][a-z0-9+.-]*:$/.test(v) && !['file:', 'javascript:', 'data:', 'vbscript:'].includes(v);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Имя переменной в `env` правила `process`, `pty`, `launch`: точное или маска `ПРЕФИКС_*` - переменные с переменным номером (`GIT_CONFIG_KEY_<n>`). */
const ENV_RULE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:_\*)?$/;
/** Имя переменной подходит под запись `env` правила: точное совпадение либо префикс маски и номер из десятичных цифр (так читает `GIT_CONFIG_KEY_<n>` сам Git). `GIT_*` и `LD_*` покрывают поэтому лишь `GIT_<n>` и `LD_<n>`, а не `GIT_SSH_COMMAND` и `LD_PRELOAD`: права словами не обещают больше, чем пропускает шлюз. */
export const envNameAllowed = (entry: string, name: string): boolean => (entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) && /^\d+$/.test(name.slice(entry.length - 1)) : entry === name);

/** Программа правила `process` и `pty`: оболочка входа человека; ядро подставляет её путь само. */
export const LOGIN_SHELL = '$SHELL';
/** Первый флаг из `deny` правила, который стоит в argv после закреплённых `args`: элемент равен флагу или начинается с `флаг=`. Возвращает запись из `deny` (без значения аргумента). Склеенные короткие флаги (`-xD`) и значения других флагов (`--header --output`) эта проверка не отличает и не разбирает. */
export function deniedFlag(rule: { readonly args: readonly string[]; readonly deny?: readonly string[] }, argv: readonly string[]): string | undefined {
  if (rule.deny === undefined) return undefined;
  for (const arg of argv.slice(rule.args.length)) {
    const hit = rule.deny.find((flag) => arg === flag || arg.startsWith(`${flag}=`));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

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
  for (const key of Object.keys(raw)) if (!(PERMISSION_KEYS as readonly string[]).includes(key)) errors.push(`permissions.${key}: неизвестное право`);
  const out: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined) out[key] = value;
  };
  const areas = `области ${AREAS.join(', ')}, абсолютные пути или маски под названным каталогом`;
  set('fs.read', strings('fs.read', raw['fs.read'], errors, isArea, areas));
  set('fs.write', strings('fs.write', raw['fs.write'], errors, isWriteArea, `${areas}, workspace.git`));
  set('shell', strings('shell', raw.shell, errors, (v) => v === ANY_PATH || isArea(v) || isScheme(v), `${areas}, ${ANY_PATH} или схемы URL с двоеточием, кроме file:`));
  set('net', strings('net', raw.net, errors, (v) => HOST.test(v), 'хосты или config:<поле>'));
  set('env', strings('env', raw.env, errors, (v) => ENV_NAME.test(v), 'имена переменных'));
  set('secrets.ref', strings('secrets.ref', raw['secrets.ref'], errors, (v) => /^[a-z][a-z0-9+.-]*:\/\/./.test(v), 'маски ссылок со схемой'));
  set('clipboard', strings('clipboard', raw.clipboard, errors, (v) => v === 'read' || v === 'write', 'read, write'));
  for (const flag of ['notify', 'security.roots', 'ui.lock', 'serve'] as const) {
    if (raw[flag] === undefined) continue;
    if (typeof raw[flag] !== 'boolean') errors.push(`permissions.${flag}: ожидается true или false`);
    else if (raw[flag]) set(flag, true);
  }
  for (const key of ['process', 'pty', 'launch'] as const) {
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
          (r.env === undefined || (Array.isArray(r.env) && r.env.every((v) => typeof v === 'string' && ENV_RULE_NAME.test(v))))),
    );
    if (!ok) errors.push(`permissions.${key}: ожидается список программ или {program, args, env?${key === 'launch' ? '' : ', deny?'}}, имя в env - точное или ПРЕФИКС_*; ${LOGIN_SHELL} - только с флагом и скриптом в args`);
    else {
      // Запрет флагов - у запуска самого плагина; `launch` описывает запуск потребителя, и молчаливое «запрещено» там ничего бы не держало.
      const badDeny = (rules ?? []).flatMap((r, i) => {
        if (!isRecord(r) || r.deny === undefined) return [];
        if (key === 'launch') return [`permissions.${key}[${i}].deny: поле только у process и pty`];
        return Array.isArray(r.deny) && r.deny.every((f) => typeof f === 'string' && f.length > 0) ? [] : [`permissions.${key}[${i}].deny: ожидается список непустых строк - флаги, например "--output"`];
      });
      errors.push(...badDeny);
      if (badDeny.length === 0) set(key, rules);
    }
  }
  return out;
}

const AREA_WORDS: Readonly<Record<string, string>> = {
  workspace: 'проекты воркспейса',
  'workspace.git': 'проекты воркспейса вместе с .git',
  'plugin-data': 'свои данные',
  'plugin-temp': 'свой временный каталог',
  granted: 'выбранное человеком в диалоге',
  [ANY_PATH]: 'любой документ или каталог',
};
const areaWords = (areas: readonly string[]) => areas.map((a) => AREA_WORDS[a] ?? a).join(', ');

/** Чужие плагины получают от этого плагина не право, а возможность: его команды с `callers: "plugins"`. Рядом с правами, теми же словами. */
export function describeOpenCommands(commands: Readonly<Record<string, { readonly callers?: string }>>): string[] {
  const open = Object.entries(commands).filter(([, spec]) => spec.callers === 'plugins');
  return open.length === 0 ? [] : [`другие плагины могут звать команды: ${open.map(([name]) => name).join(', ')}`];
}

/** Права словами: те же строки покажет окно согласия второго этапа. */
export function describePermissions(p: PluginPermissions): string[] {
  const out: string[] = [];
  if (p['fs.read']) out.push(`читает файлы: ${areaWords(p['fs.read'])}`);
  if (p['fs.write']) out.push(`пишет файлы: ${areaWords(p['fs.write'])}`);
  // Свои каталоги плагин пишет и без права `fs.write`.
  const writes = p['fs.write'] !== undefined || p.shell?.some((a) => a === 'plugin-data' || a === 'plugin-temp' || a === ANY_PATH);
  if (p.shell) out.push(`открывает в системе: ${areaWords(p.shell)} - кроме программ и скриптов${writes ? '; где сам пишет - только документы' : ''}`);
  const program = (p: string) => (p === LOGIN_SHELL ? 'оболочка входа' : p);
  const programs = (rules: PluginPermissions['process']) =>
    (rules ?? []).map((r) => (typeof r === 'string' ? r : [program(r.program), ...r.args].join(' ') + (r.env?.length ? ` (окружение: ${r.env.join(', ')})` : '') + (r.deny?.length ? ` (запрещены флаги: ${r.deny.join(', ')})` : ''))).join(', ');
  if (p.process) out.push(`запускает программы: ${programs(p.process)} - полный доступ через программу`);
  if (p.pty) out.push(`запускает в терминале: ${programs(p.pty)} - полный доступ через программу`);
  if (p.launch) out.push(`предлагает запуск в терминале: ${programs(p.launch)} - его выполнит потребитель`);
  if (p.net) out.push(`ходит в сеть: ${p.net.map((h) => (h.startsWith('config:') ? `хост из настройки ${h.slice('config:'.length)}` : h)).join(', ')}`);
  if (p.env) out.push(`читает переменные окружения: ${p.env.join(', ')}`);
  if (p.notify) out.push('показывает системные уведомления');
  if (p.clipboard) out.push(`буфер обмена: ${p.clipboard.map((c) => (c === 'read' ? 'чтение' : 'запись')).join(', ')}`);
  if (p['secrets.ref']) out.push(`читает секреты ${p['secrets.ref'].join(', ')}`);
  if (p['security.roots']) out.push('задаёт корни проектов, доступные другим плагинам');
  if (p['ui.lock']) out.push('может закрыть окно Cyborg');
  if (p.serve) out.push('принимает запросы HTTP на 127.0.0.1 - от программ этого компьютера');
  return out;
}

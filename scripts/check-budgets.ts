import fs from 'node:fs';
import path from 'node:path';

// `node scripts/check-budgets.ts --gateway gateway.json [--hosts hosts.json] [--platform linux] [--budgets playground/budgets.json] [--summary файл.md]` -
// сверка замеров с порогами из файла в репозитории (P-10, бюджеты NFR-CH-1001). Сами замеры гоняют `npm run spike:gateway -- --json` и
// `npm run spike:hosts -- --json`; здесь только сравнение: пороги лежат в одном месте (`playground/budgets.json`) и не повторяются в workflow.

export interface Budgets {
  readonly decision: { readonly source: string; readonly row: number; readonly date: string };
  readonly gateway: {
    readonly callP99Ms: number;
    readonly watchP99Ms: number;
    readonly maxBytes: number;
    /** Платформы, где превышение красит PR. */
    readonly blocking: readonly string[];
    /** Пути, которые красят PR; остальные шумят на раннере и идут справочно. */
    readonly guarded: readonly string[];
    /** Запас на шум раннера: красит значение выше бюджета, умноженного на него. */
    readonly blockingMargin: number;
  };
  readonly hosts: {
    readonly blocking: readonly string[];
    readonly limits: Readonly<Record<string, { readonly pssPerHostMb: number | null; readonly callP99Ms: number | null } | undefined>>;
  };
}

/** Стоимость одного пути из JSON `spike-gateway.mjs --json`. */
interface GatewayCost {
  readonly path: string;
  readonly sizeBytes: number;
  readonly gatewayP99: number | null;
  readonly pluginP99: number | null;
}

interface GatewayResult {
  readonly costs?: readonly GatewayCost[];
  readonly runs?: readonly { readonly code?: number; readonly error?: string }[];
}

interface HostsResult {
  readonly error?: string;
  readonly memory?: readonly { readonly layout: string; readonly pssPerHostMb: number | null }[];
  readonly calls?: readonly { readonly path: string; readonly sizeBytes: number; readonly p99: number }[];
}

export interface Finding {
  readonly metric: string;
  /** Измеренное число; `NaN`, если замер не дал числа. */
  readonly value: number;
  /** Порог; `null` - порога нет, строка информационная. */
  readonly limit: number | null;
  readonly unit: string;
  /** Выше порога или числа нет при заданном пороге. */
  readonly over: boolean;
  /** Метрика на страже: порог задан, платформа в `blocking`, путь в `guarded`. */
  readonly blocking: boolean;
  /** Выше этого числа PR красный (бюджет с запасом на шум); `null` - порога нет. */
  readonly blockAbove: number | null;
}

const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

function finding(metric: string, value: number, limit: number | null, unit: string, blocking: boolean, margin = 1): Finding {
  return { metric, value, limit, unit, over: limit !== null && !(value <= limit), blocking: blocking && limit !== null, blockAbove: limit === null ? null : limit * margin };
}

/** Красит ли строка PR: на страже и значение выше порога блокировки (NaN - тоже). */
export function fails(f: Finding): boolean {
  return f.blocking && f.blockAbove !== null && !(f.value <= f.blockAbove);
}

/**
 * Читает JSON замера. `spike-*.mjs --json` печатает объект через `JSON.stringify(r, null, 2)`: `{` и `}` в первой колонке, но Electron и xvfb
 * пишут в тот же stdout свои строки и до объекта («Downloading Electron binary...»), и после него. Берётся первая пара «строка `{` ... строка `}`», которая разбирается.
 */
export function parseMeasurement(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (first) {
    const lines = text.split('\n');
    for (let start = lines.indexOf('{'); start !== -1; start = lines.indexOf('{', start + 1)) {
      for (let end = lines.indexOf('}', start); end !== -1; end = lines.indexOf('}', end + 1)) {
        try {
          return JSON.parse(lines.slice(start, end + 1).join('\n'));
        } catch {
          // не тот закрывающий `}`: ищем следующий
        }
      }
    }
    throw new Error('в выводе замера нет JSON', { cause: first });
  }
}

/** Цена шлюза против порогов: по каждому пути до `maxBytes`; `fs.watch` - свой порог (сверх склейки). Прогон с ошибкой или без цен - превышение. */
export function checkGateway(budgets: Budgets, result: GatewayResult, platform: string): Finding[] {
  const g = budgets.gateway;
  const blocking = g.blocking.includes(platform);
  const findings: Finding[] = [];
  (result.runs ?? []).forEach((run, index) => {
    if ((run.code !== undefined && run.code !== 0) || run.error !== undefined) {
      findings.push(finding(`прогон ${String(index + 1)} шлюза не выполнен: ${run.error ?? `код ${String(run.code)}`}`, NaN, 0, '', blocking));
    }
  });
  const costs = (result.costs ?? []).filter((c) => c.sizeBytes <= g.maxBytes);
  if (costs.length === 0) findings.push(finding('замер шлюза не дал ни одной цены', NaN, 0, '', blocking));
  for (const c of costs) {
    // У net.fetch проверка адреса из плагина не мерится (шлюз отверг бы 127.0.0.1 под именем): тогда берётся цена транспорта с проверкой.
    const value = finite(c.pluginP99) ? c.pluginP99 : (c.gatewayP99 ?? NaN);
    findings.push(finding(`${c.path}, ${String(c.sizeBytes)} Б`, value, c.path === 'fs.watch' ? g.watchP99Ms : g.callP99Ms, 'мс', blocking && g.guarded.includes(c.path), g.blockingMargin));
  }
  return findings;
}

/** Хосты: память на хост и p99 вызова против порогов платформы; `null` в файле - порога нет, строка информационная. */
export function checkHosts(budgets: Budgets, result: HostsResult, platform: string, maxBytes: number): Finding[] {
  const blocking = budgets.hosts.blocking.includes(platform);
  const limits = budgets.hosts.limits[platform];
  const findings: Finding[] = [];
  if (result.error !== undefined) findings.push(finding(`замер хостов не выполнен: ${result.error}`, NaN, 0, '', blocking));
  const pss = (result.memory ?? []).map((m) => m.pssPerHostMb).filter(finite);
  if (pss.length > 0) findings.push(finding('память на хост (максимум по раскладкам)', Math.max(...pss), limits?.pssPerHostMb ?? null, 'МБ', blocking));
  const calls = (result.calls ?? []).filter((c) => c.path.startsWith('главный -> хост') && c.sizeBytes <= maxBytes).map((c) => c.p99);
  if (calls.length > 0) findings.push(finding('вызов главный -> хост, p99 (максимум по размерам)', Math.max(...calls), limits?.callP99Ms ?? null, 'мс', blocking));
  return findings;
}

const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : 'нет числа');

function status(f: Finding): string {
  if (fails(f)) return 'ПРЕВЫШЕН';
  if (f.over) return f.blocking ? `выше бюджета, в запасе до ${fmt(f.blockAbove ?? NaN)}` : 'выше бюджета, не блокирует';
  return f.limit === null ? 'информационно' : 'в бюджете';
}

/** Таблица для журнала шага и `$GITHUB_STEP_SUMMARY`. */
export function render(title: string, findings: readonly Finding[]): string {
  if (findings.length === 0) return `### ${title}\n\nзамер не дал строк\n`;
  const rows = findings.map((f) => `| ${f.metric} | ${fmt(f.value)}${f.unit ? ` ${f.unit}` : ''} | ${f.limit === null ? 'не задан' : `${fmt(f.limit)} ${f.unit}`.trim()} | ${status(f)} |`);
  return `### ${title}\n\n| Метрика | Замер | Порог | Итог |\n|---|---|---|---|\n${rows.join('\n')}\n`;
}

export interface CheckOutput {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} требует значение`);
  return value;
}

/** Разбор командной строки и сверка; код 1, если блокирующий порог превышен. Нет файла замера или порогов - исключение, а не «зелёное». */
export function main(args: readonly string[], root: string): CheckOutput {
  const gatewayFile = option(args, 'gateway');
  const hostsFile = option(args, 'hosts');
  if (gatewayFile === undefined && hostsFile === undefined) throw new Error('нужен --gateway <файл> и/или --hosts <файл>');
  const platform = option(args, 'platform') ?? process.platform;
  const budgetsFile = path.resolve(root, option(args, 'budgets') ?? 'playground/budgets.json');
  const budgets = JSON.parse(fs.readFileSync(budgetsFile, 'utf8')) as Budgets;
  const sections: string[] = [`Пороги: ${path.relative(root, budgetsFile)} (решение D-00, строка ${String(budgets.decision.row)}, ${budgets.decision.date}); платформа ${platform}\n`];
  const all: Finding[] = [];
  if (gatewayFile !== undefined) {
    const findings = checkGateway(budgets, parseMeasurement(fs.readFileSync(path.resolve(root, gatewayFile), 'utf8')) as GatewayResult, platform);
    sections.push(render('Шлюз ctx.os (медиана p99 цены за прогоны)', findings));
    all.push(...findings);
  }
  if (hostsFile !== undefined) {
    const findings = checkHosts(budgets, parseMeasurement(fs.readFileSync(path.resolve(root, hostsFile), 'utf8')) as HostsResult, platform, budgets.gateway.maxBytes);
    sections.push(render('Хосты плагинов', findings));
    all.push(...findings);
  }
  const text = sections.join('\n');
  const summary = option(args, 'summary');
  if (summary !== undefined) fs.appendFileSync(path.resolve(root, summary), `${text}\n`);
  const failed = all.filter(fails);
  if (failed.length === 0) return { code: 0, out: text, err: '' };
  return { code: 1, out: text, err: `бюджет превышен: ${failed.map((f) => `${f.metric} ${fmt(f.value)} ${f.unit} при пороге блокировки ${fmt(f.blockAbove ?? NaN)}`).join('; ')}\n` };
}

if (process.argv[1] === import.meta.filename) {
  try {
    const result = main(process.argv.slice(2), process.cwd());
    process.stdout.write(result.out);
    process.stderr.write(result.err);
    process.exitCode = result.code;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

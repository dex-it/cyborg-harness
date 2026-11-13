import { PLUGIN_API_VERSION } from './api-version.ts';
import type { StoredRecord } from './diagnostics-record.ts';
import type { ContractGraph } from './graph.ts';
import type { Kernel } from './kernel-types.ts';
import { describeEntry, entryLevel, pluginStatuses, type PluginState } from './status.ts';

/*
 * Выгрузка диагностики (K-30, FR-CH-4015, 4016): один текстовый файл, читаемый без инструментов. Что в него входит: версии ядра и плагинов, их состояние на момент выгрузки,
 * граф контрактов и записи всех хранимых файлов по времени; запись трассы несёт номер цепочки. Значений секретов в записях нет (NFR-CH-4002), содержимого аргументов нет,
 * пока приложение не запущено с `--trace-args` (FR-CH-4004, K-33): тогда записи несут аргументы, и заголовок выгрузки об этом предупреждает. Предупреждение выводится из самих записей,
 * а не из флага этого запуска: аргументы прошлого запуска остаются в файлах, пока их не вытеснит ротация. Этот модуль ничего не читает из сети и никуда не пишет: файл на диск кладёт приложение, отправки нет.
 */

export interface ExportContext {
  /** Имя и версия приложения. */
  readonly app?: string;
  /** Версия пакета ядра. */
  readonly core?: string;
  /** Ядро этого запуска: манифесты дают версии плагинов, журнал - их состояние, `hostOf` - хост. Без него в выгрузке только записи. */
  readonly kernel?: Pick<Kernel, 'manifests' | 'journal' | 'hostOf'>;
}

export interface ExportInput {
  readonly now: number;
  /** Запуск, который выгружает. */
  readonly run: number;
  readonly records: readonly StoredRecord[];
  readonly files: readonly { readonly name: string; readonly bytes: number }[];
  /** Сколько записей ещё не в файле (отказ записи): они в выгрузке есть. */
  readonly unsaved: number;
  /** Строк, которые не разобрались, и файлов, которые не прочитались. */
  readonly unreadable: number;
  readonly graph: ContractGraph | undefined;
  readonly limits: { readonly files: number; readonly fileBytes: number; readonly keepBytes?: number };
  readonly problem?: string;
  readonly context: ExportContext;
}

const STATE: Record<PluginState, string> = { active: 'работает', waiting: 'ждёт вызова', restarting: 'перезапуск', stopped: 'выключен', disabled: 'не включён' };

function iso(at: number): string {
  try {
    return new Date(at).toISOString();
  } catch {
    return String(at);
  }
}

/** Строка записи в одну строку файла: перевод строки внутри текста плагина заменён, иначе одна запись выглядела бы как несколько. */
const oneLine = (text: string): string => text.replace(/\r?\n/g, ' ⏎ ');

function describeRecord({ record }: StoredRecord): string {
  switch (record.src) {
    case 'run':
      return `запуск приложения${record.app === undefined ? '' : ` ${record.app}`}`;
    case 'journal': {
      const e = record.entry;
      const subject = e.pluginId ?? (e.kind === 'key-ignored' ? 'сочетания' : e.kind === 'trace-args' ? 'трасса' : e.kind === 'delivery-failed' ? 'поставка' : `хост ${e.hostId}`);
      return `журнал ${entryLevel(e)} ${subject}: ${oneLine(describeEntry(e))}`;
    }
    case 'log':
      return `строка ${record.level} ${record.pluginId}: ${oneLine(record.text)}`;
    case 'oversize':
      return `запись (${record.from}) размером ${String(record.bytes)} Б не помещается в строку файла и не сохранена`;
    case 'trace': {
      const t = record.record;
      if (t.kind === 'stream') return `трасса поток ${t.stream} ${t.pluginId}${t.hostId === undefined ? '' : ` (хост ${t.hostId})`}: сообщений ${String(t.messages)}, ${String(t.bytes)} Б за ${String(t.intervalMs)} мс`;
      if (t.kind === 'exit') return `трасса выход ${t.target} ${t.pluginId}${t.chain === undefined ? '' : ` цепочка ${String(t.chain)}`}: код ${String(t.code)}${t.signal === undefined ? '' : `, сигнал ${String(t.signal)}`}`;
      const result = t.outcome === 'ok' ? 'успех' : `отказ ${t.code ?? '?'}${t.reason === undefined ? '' : ` (${t.reason})`}`;
      return (
        `трасса операция #${String(t.id)} цепочка ${String(t.chain)}: ${t.caller} -> ${t.target}${t.callee === undefined ? '' : ` [${t.callee}]`}, границы ${t.boundaries.join(' ')}` +
        `${t.right === undefined ? '' : `, право ${t.right}`}, ${String(t.durationMs)} мс, аргументы ${String(t.argsBytes)} Б, результат ${String(t.resultBytes)} Б, ${result}` +
        (t.args === undefined ? '' : `, аргументы: ${oneLine(t.args)}`)
      );
    }
  }
}

function plugins(kernel: NonNullable<ExportContext['kernel']>): string[] {
  const states = new Map(pluginStatuses(kernel.journal).map((s) => [s.id, s]));
  const lines = [...kernel.manifests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => {
      const s = states.get(m.id);
      const host = s && s.state !== 'disabled' ? kernel.hostOf(m.id) : undefined;
      const why = s?.cause && s.state !== 'active' ? `: ${oneLine(describeEntry(s.cause))}` : '';
      return `  ${m.id} ${m.version} - ${s ? STATE[s.state] : 'состояния нет'}${host === undefined ? '' : `, хост ${host}`}${why}`;
    });
  return lines.length === 0 ? ['  плагинов нет'] : lines;
}

function graph(g: ContractGraph): string[] {
  const out = [`  порядок активации: ${g.order.join(', ') || 'пусто'}`];
  const bound = [...g.bindings].flatMap(([consumer, byContract]) => [...byContract].map(([contract, provider]) => `${consumer} <- ${contract}: ${provider}`));
  out.push(`  привязки: ${bound.length === 0 ? 'нет' : ''}`.trimEnd(), ...bound.map((b) => `    ${b}`));
  for (const [id, reasons] of g.rejected) out.push(`  отвергнут ${id}: ${oneLine(describeEntry({ pluginId: id, kind: 'rejected', reasons }))}`);
  return out;
}

export function formatExport(input: ExportInput): string {
  const { context, records } = input;
  const sorted = [...records].sort((a, b) => a.record.at - b.record.at);
  const runs = [...new Set(records.map((r) => r.run).concat(input.run))].sort((a, b) => a - b);
  const tag = (run: number) => `з${String(runs.indexOf(run) + 1)}`;
  const earliest = sorted[0]?.record.at;
  const withArgs = records.some(({ record }) => (record.src === 'trace' && record.record.kind === 'operation' && record.record.args !== undefined) || (record.src === 'journal' && record.entry.kind === 'trace-args'));
  const kib = (n: number) => `${String(Math.round(n / 1024))} КиБ`;
  const out: string[] = [
    'Диагностика Cyborg Harness',
    `Выгружена: ${iso(input.now)}`,
    ...(context.app === undefined ? [] : [`Приложение: ${context.app}`]),
    `Ядро: ${context.core === undefined ? '' : `пакет ${context.core}, `}API плагинов ${PLUGIN_API_VERSION}`,
    `Записей: ${String(records.length)}; самая ранняя: ${earliest === undefined ? 'нет' : iso(earliest)}; файлов: ${String(input.files.length)} (${kib(input.files.reduce((n, f) => n + f.bytes, 0))}).`,
    `Хранится не больше ${String(input.limits.files)} файлов по ${kib(input.limits.fileBytes)}${input.limits.keepBytes === undefined ? '' : ` и файл записей сбоев и жизненного цикла до ${kib(input.limits.keepBytes)}`}: что старше самой ранней записи, ушло при ротации (записи сбоев ротация сохраняет), цепочка без начала оборвана с этой стороны.`,
    `Запуски: ${runs.map((run) => `${tag(run)} с ${iso(run)}${run === input.run ? ' (этот)' : ''}`).join('; ')}`,
    ...(input.unsaved > 0 ? [`Не записано в файл: ${String(input.unsaved)} (запись на диск не удаётся${input.problem === undefined ? '' : `: ${input.problem}`}); они в выгрузке ниже.`] : []),
    ...(input.unreadable > 0 ? [`Не разобрано строк или файлов: ${String(input.unreadable)}.`] : []),
    ...(withArgs
      ? [
          'ВНИМАНИЕ: в записях есть аргументы операций (запуск с --trace-args): пути, имена и данные человека, обрезанные до предела; значения секретов, прошедшие через шлюз ядра, вычеркнуты, а токен, собранный плагином самим, остаётся. Результатов операций в записях нет. Просмотрите файл, прежде чем прикладывать его к обращению или отправлять. Файл остаётся на этой машине: ядро его никуда не отправляет.',
        ]
      : ['В записях нет содержимого аргументов и результатов операций (только размеры) и значений секретов из хранилища ядра. Файл остаётся на этой машине: ядро его никуда не отправляет.']),
    '',
  ];
  if (context.kernel) out.push('Плагины (состояние на момент выгрузки):', ...plugins(context.kernel), '');
  if (input.graph) out.push('Граф контрактов:', ...graph(input.graph), '');
  out.push('Записи по времени:');
  for (const stored of sorted) {
    let text: string;
    try {
      text = describeRecord(stored);
    } catch {
      // Файл могли править руками: запись с неожиданной формой не должна ломать выгрузку целиком.
      text = 'запись нечитаема';
    }
    out.push(`${iso(stored.record.at)} ${tag(stored.run)} ${text}`);
  }
  return `${out.join('\n')}\n`;
}

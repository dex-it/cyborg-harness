import { readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { CoreError, errorMessage, forkHosts, isRecord, load, parseManifest, PLUGIN_API_VERSION, SectionStore, type ContractGraph, type JournalEntry, type LayerStore, type Rejection } from '../src/index.ts';
import { scenarios, type Documents, type Scenario } from './scenarios.ts';

const pluginsDir = new URL('./plugins/', import.meta.url);

const tty = process.stdout.isTTY;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const cyan = paint(36);

const args = process.argv.slice(2);
const step = args.includes('--step');
const names = args.filter((a) => !a.startsWith('--'));

if (args.includes('--help') || names.some((n) => n !== 'all' && !scenarios.some((s) => s.name === n))) {
  console.log(`${bold('npm run demo -- [сценарий ...|all] [--step]')}\n`);
  for (const s of scenarios) console.log(`  ${cyan(s.name.padEnd(10))} ${s.title}`);
  console.log(`\n  без имени - basic; --step - пауза на Enter после каждого шага`);
  process.exit(names.length > 0 && !args.includes('--help') ? 1 : 0);
}

const chosen = names.includes('all') ? scenarios : names.length > 0 ? scenarios.filter((s) => names.includes(s.name)) : [scenarios[0]];
const prompt = step && process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;

async function pause(): Promise<void> {
  if (prompt) await prompt.question(dim('  Enter - дальше '));
}

function heading(n: number, title: string): void {
  console.log(`\n${bold(`Шаг ${n}. ${title}`)}`);
}

function readManifests(): unknown[] {
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => JSON.parse(readFileSync(new URL(`${d.name}/manifest.json`, pluginsDir), 'utf8')) as unknown);
}

const entry = (manifest: { id: string }) => new URL(`${manifest.id}/index.ts`, pluginsDir).href;

function memoryStore(initial: Documents = {}): { store: LayerStore; docs: Map<string, Record<string, unknown>> } {
  const docs = new Map(Object.entries(structuredClone(initial)));
  return {
    docs,
    store: {
      load: async (layer) => structuredClone(docs.get(layer)),
      save: async (layer, doc) => void docs.set(layer, structuredClone(doc)),
    },
  };
}

function rejection(r: Rejection): string {
  switch (r.kind) {
    case 'duplicate':
      return 'id уже занят другим манифестом';
    case 'engines':
      return `требует ядро ${r.range}, а ядро ${r.api}`;
    case 'missing':
      return `нет поставщика ${r.contract} ${r.range}`;
    case 'ambiguous':
      return `${r.contract}: поставщиков несколько (${r.providers.join(', ')}), а кратность one`;
    case 'cycle':
      return `цикл зависимостей: ${r.members.join(' -> ')}`;
    case 'reserved':
      return `${r.what === 'id' ? 'id' : 'контракт'} ${r.name} из пространства поставки ${r.prefix}*, а плагин сторонний`;
  }
}

function journalLine(e: JournalEntry): string {
  const id = (e.pluginId ?? '').padEnd(16);
  switch (e.kind) {
    case 'invalid':
      return `${red('✖')} ${id} манифест не разобран:\n${e.errors.map((x) => `                     ${dim(x)}`).join('\n')}`;
    case 'disabled':
      return `${dim('·')} ${dim(`${id} есть на диске, но не в plugins.enabled`)}`;
    case 'not-found':
      return `${red('✖')} ${id} в plugins.enabled, но манифеста нет`;
    case 'rejected':
      return `${red('✖')} ${id} ${e.reasons.map(rejection).join('; ')}`;
    case 'safe-mode':
      return `${yellow('◌')} ${id} безопасный режим: код не запускается`;
    case 'skipped':
      return `${yellow('◌')} ${id} пропущен: ${e.reason}`;
    case 'waiting':
      return `${dim('◌')} ${id} ждёт первой команды`;
    case 'config':
    case 'state': {
      const r = e.result;
      const why =
        r.status === 'newer'
          ? `в слое ${r.layer} версия ${r.found}, плагин знает только до ${r.expected} - откат версии, данные не трогаю`
          : r.status === 'migrate-error'
            ? `миграция слоя ${r.layer} с версии ${r.from} упала: ${r.error}`
            : r.status === 'invalid'
              ? `значение не прошло проверку: ${r.errors.join('; ')}`
              : '';
      return `${red('✖')} ${id} раздел ${e.kind} не поднялся: ${why}`;
    }
    case 'failed':
      return `${red('✖')} ${id} activate бросил: ${e.error}`;
    case 'activated':
      return `${green('✔')} ${id} активен ${dim(`в хосте ${e.hostId}, за ${e.ms.toFixed(1)} мс`)}`;
    case 'deactivated':
      return e.error ? `${red('✖')} ${id} снят с ошибкой: ${e.error}` : `${dim('↓')} ${id} снят`;
    case 'unhandled-rejection':
      return `${yellow('⚠')} ${id} необработанное отклонение промиса: ${e.error}`;
    case 'switched-off':
      return `${red('⏻')} ${id} выключен после ${e.strikes} сбоев за сессию${e.affects.length > 0 ? `; без него: ${e.affects.join(', ')}` : ''}`;
    case 'host-down': {
      const why = e.reason === 'hang' ? 'завис - не ответил на пинг' : 'процесс завершился';
      const blame = e.culprits.length > 0 ? `виновник ${e.culprits.join(', ')}` : 'виновник не установлен';
      const hit = e.affects.length > 0 ? `; задеты ${e.affects.join(', ')}` : '';
      return `${red('✖')} ${bold(`хост ${e.hostId}`)} ${why}; ${blame}; сняты ${e.plugins.join(', ') || 'никто'}${hit}`;
    }
    case 'host-restart':
      return `${yellow('↻')} ${bold(`хост ${e.hostId}`)} перезапуск: ${e.plugins.join(', ')}`;
    case 'host-abandoned':
      return `${red('✖')} ${bold(`хост ${e.hostId}`)} брошен после ${e.failures} сбоев без виновника; выключены ${e.plugins.join(', ') || 'никто'}`;
    case 'revived':
      return `${yellow('↻')} ${id} включён снова`;
    case 'denied':
      return `${yellow('⛔')} ${id} отказ ctx.os: ${e.detail}`;
    case 'unloaded':
      return `${dim('⏏')} ${id} выгружен${e.by === e.pluginId ? '' : ` вместе с ${e.by}`}${e.error ? `, ошибка: ${e.error}` : ''}`;
    case 'uninstalled':
      return `${e.error ? red('✖') : dim('␡')} ${id} удалён; стёрто: ${e.erased.join(', ') || 'ничего'}${e.error ? `; не удалось: ${e.error}` : ''}`;
    case 'pty-expired':
      return `${yellow('⚠')} ${id} терминал ${e.id} (${e.program}) завершён: не подхвачен за ${String(e.graceMs / 1000)} с`;
    case 'key-conflict':
      return `${yellow('⌨')} ${id}: ${e.key} уже у ${e.winner}, ${e.command} не получит нажатие`;
    case 'key-ignored':
      return `${yellow('⌨')} plugins.keybindings: ${e.key} -> ${String(e.command)} не применено: ${e.reason}`;
    case 'host-isolated':
      return `${yellow('◌')} ${id} сторонний: группа ${e.group} не действует, свой хост ${e.hostId}`;
    case 'host-own-grouped':
      return `${yellow('◌')} ${id} просит свой хост, но группа ${e.group} сажает его к ${e.neighbours.join(', ')}`;
  }
}

function printManifests(raw: unknown[], enabled: readonly string[]): void {
  const listed = (label: string, entries: Record<string, string | readonly string[]>, sep: string) => {
    const items = Object.entries(entries).map(([c, v]) => `${c}${sep}${[v].flat().join('+')}`);
    return items.length > 0 ? `${label} ${items.join(', ')}` : undefined;
  };
  const seen = new Set<string>();
  for (const parsed of raw.map((m) => parseManifest(m))) {
    if (!parsed.ok || !enabled.includes(parsed.manifest.id)) continue;
    const m = parsed.manifest;
    seen.add(m.id);
    const parts = [
      listed('отдаёт', m.provides, '@'),
      listed('требует', m.requires, ' '),
      listed('может взять', m.optional, ' '),
      listed('собирает', m.consumes, ' '),
      m.config && `config v${m.config.version}`,
      m.state && `state v${m.state.version}`,
    ].filter((p) => p !== undefined);
    console.log(`  ${cyan(`${m.id}@${m.version}`.padEnd(22))} ${parts.join(dim(' | ')) || dim('без контрактов')}`);
  }
  const missing = enabled.filter((id) => !seen.has(id));
  if (missing.length > 0) console.log(`  ${dim(`в enabled, но нет на диске или манифест с ошибкой: ${missing.join(', ')}`)}`);
}

function printGraph(graph: ContractGraph): void {
  console.log(`  порядок активации: ${graph.order.map((id) => cyan(id)).join(dim(' → ')) || dim('пусто')}`);
  for (const [consumer, bound] of graph.bindings) {
    for (const [contract, provider] of bound) console.log(`  ${dim('связь')} ${consumer} ${dim(`← ${contract} ←`)} ${provider}`);
  }
}

function printDocuments(label: string, docs: ReadonlyMap<string, unknown>): void {
  for (const [layer, doc] of docs) console.log(`  ${dim(`${label} ${layer}:`)} ${JSON.stringify(doc)}`);
}

async function runScenario(s: Scenario): Promise<void> {
  console.log(`\n${bold(cyan(`━━ ${s.name}: ${s.title}`))}\n${s.point}`);

  const raw = readManifests();
  const config = memoryStore(s.config);
  const state = memoryStore(s.state);

  heading(1, 'Манифесты и plugins.enabled');
  printManifests(raw, s.enabled);
  printDocuments('config', config.docs);
  printDocuments('state', state.docs);
  await pause();

  heading(2, 'Граф контрактов - до запуска кода');
  const early: JournalEntry[] = [];
  let activationStarted = false;
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: s.enabled,
    manifests: raw,
    spawnHost: forkHosts(),
    entry,
    hosts: s.hosts,
    bundled: s.bundled ?? raw.map((m) => (isRecord(m) && typeof m.id === 'string' ? m.id : '')),
    watchdog: { interval: 100, timeout: 800, strikes: 2 },
    config: await SectionStore.open(config.store, ['user', 'workspace']),
    state: await SectionStore.open(state.store, ['workspace']),
    safeMode: s.safeMode,
    onJournal: (e) => {
      if (activationStarted) console.log(`  ${journalLine(e)}`);
      else early.push(e);
    },
    onLog: (id, message) => console.log(`      ${dim(`${id}:`)} ${message}`),
    async onGraph(graph) {
      const disabled = early.filter((e) => e.kind === 'disabled').map((e) => e.pluginId);
      if (disabled.length > 0) console.log(`  ${dim(`· не в plugins.enabled: ${disabled.join(', ')}`)}`);
      for (const e of early) if (e.kind !== 'disabled') console.log(`  ${journalLine(e)}`);
      printGraph(graph);
      await pause();
      heading(3, 'Активация по порядку графа');
      activationStarted = true;
    },
  });
  printDocuments('config', config.docs);
  printDocuments('state', state.docs);
  await pause();

  if (s.act && kernel.active.length > 0) {
    heading(4, 'Работа: команды через ядро');
    await s.act(kernel, async (command, ...args) => {
      const call = `${command}(${args.map((a) => JSON.stringify(a)).join(', ')})`;
      try {
        const result = await kernel.run(command, ...args);
        const lines = Array.isArray(result) ? result.map(String) : [typeof result === 'string' ? result : JSON.stringify(result)];
        console.log(`  ${cyan(call)}\n${lines.map((l) => `      ${l}`).join('\n')}`);
      } catch (error) {
        console.log(`  ${cyan(call)}\n      ${red(`${error instanceof CoreError ? error.code : 'ошибка'}: ${errorMessage(error)}`)}`);
      }
    });
    await pause();
  }

  heading(s.act && kernel.active.length > 0 ? 5 : 4, 'Снятие в обратном порядке');
  await kernel.unload();
  printDocuments('state', state.docs);
}

for (const s of chosen) if (s) await runScenario(s);
prompt?.close();

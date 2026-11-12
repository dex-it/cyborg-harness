import type { PluginManifest } from './manifest.ts';
import { satisfies } from './semver.ts';
import { own } from './wire.ts';

export type Rejection =
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'engines'; readonly range: string; readonly api: string }
  | { readonly kind: 'missing'; readonly contract: string; readonly range: string }
  | { readonly kind: 'ambiguous'; readonly contract: string; readonly providers: readonly string[] }
  | { readonly kind: 'cycle'; readonly members: readonly string[] }
  | { readonly kind: 'command'; readonly command: string; readonly with: readonly string[] }
  | { readonly kind: 'reserved'; readonly what: 'id' | 'provides'; readonly name: string; readonly prefix: string };

/** Пространства имён, которые занимают только плагины из поставки: `provides` и `id` с таким префиксом у стороннего - отказ. */
export interface Reserved {
  /** С точкой на конце: `app.` закрывает контракт `app.x`, id `app` и id `app.x`. */
  readonly prefixes: readonly string[];
  readonly bundled: ReadonlySet<string>;
}

export interface ContractGraph {
  /** Порядок активации: поставщик раньше потребителя по requires и optional. */
  readonly order: readonly string[];
  readonly rejected: ReadonlyMap<string, readonly Rejection[]>;
  /** Потребитель -> контракт -> поставщик для requires и найденных optional. */
  readonly bindings: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** Решает граф по одним манифестам, до запуска кода. Отказ каскадирует до неподвижной точки. */
export function resolveGraph(manifests: readonly PluginManifest[], apiVersion: string, reserved?: Reserved): ContractGraph {
  const rejected = new Map<string, Rejection[]>();
  const reject = (id: string, reason: Rejection) => {
    const list = rejected.get(id);
    if (list) list.push(reason);
    else rejected.set(id, [reason]);
  };

  const byId = new Map<string, PluginManifest>();
  for (const m of manifests) {
    if (byId.has(m.id)) reject(m.id, { kind: 'duplicate' });
    else byId.set(m.id, m);
  }
  for (const m of byId.values()) {
    if (!satisfies(apiVersion, m.engines.cyborg)) reject(m.id, { kind: 'engines', range: m.engines.cyborg, api: apiVersion });
    if (reserved && !reserved.bundled.has(m.id)) for (const r of trespasses(m, reserved.prefixes)) reject(m.id, r);
  }

  rejectSharedCommands([...byId.values()].filter((m) => !rejected.has(m.id)), reserved, reject);

  const alive = () => [...byId.values()].filter((m) => !rejected.has(m.id));
  let bindings: Map<string, Map<string, string>>;

  for (;;) {
    // Поставщик контракта - только плагин, остающийся в графе. Проход смотрит на снимок живых и ничего не отвергает сам: отказы
    // возвращает, а здесь решается, какие из них окончательные. Нехватка поставщика (missing) окончательна всегда: удаление
    // плагинов её не лечит. Неоднозначность (ambiguous) лечится отказом одного из поставщиков, поэтому, пока есть нехватка,
    // неоднозначность не фиксируется; а среди неоднозначностей откладывается та, чей спорный поставщик сам в отказе. Итог не зависит
    // от порядка входа: каждый шаг - функция множества живых.
    const { bindings: pass, failures } = bindAll(alive());
    if (failures.size > 0) {
      for (const [id, reasons] of settle(failures)) for (const reason of reasons) reject(id, reason);
      continue;
    }
    bindings = pass;
    const cycles = findCycles(bindings);
    if (cycles.length === 0) break;
    for (const members of cycles) for (const id of members) reject(id, { kind: 'cycle', members });
  }

  return { order: topoOrder(alive(), bindings), rejected, bindings };
}

/**
 * Команду объявил один плагин. Пространство имён проверяется префиксом `${id}.`, поэтому `a` и `a.b` оба могут объявить `a.b.run`;
 * кто зарегистрирует первым, тот владелец, а вид, клик по уведомлению и сочетание второго запустили бы команду первого. Отказ обоим;
 * если один из них встроенный, а остальные нет - отвергаются только остальные, иначе сторонний плагин снимал бы чужую поставку.
 */
function rejectSharedCommands(plugins: readonly PluginManifest[], reserved: Reserved | undefined, reject: (id: string, r: Rejection) => void): void {
  const declared = new Map<string, string[]>();
  for (const m of plugins) for (const command of Object.keys(m.commands)) declared.set(command, [...(declared.get(command) ?? []), m.id]);
  for (const [command, ids] of declared) {
    if (ids.length < 2) continue;
    const bundled = ids.filter((id) => reserved?.bundled.has(id));
    const losers = bundled.length === 1 ? ids.filter((id) => !bundled.includes(id)) : ids;
    for (const id of losers) reject(id, { kind: 'command', command, with: ids.filter((other) => other !== id) });
  }
}

function* trespasses(m: PluginManifest, prefixes: readonly string[]): Generator<Rejection> {
  for (const prefix of prefixes) {
    if (m.id.startsWith(prefix) || `${m.id}.` === prefix) yield { kind: 'reserved', what: 'id', name: m.id, prefix };
    for (const contract of Object.keys(m.provides)) if (contract.startsWith(prefix)) yield { kind: 'reserved', what: 'provides', name: contract, prefix };
  }
}

/** Один проход по снимку живых: каждому - поставщики из этого снимка; кто не связался, попадает в `failures` с причинами, ничего не отвергается. */
function bindAll(plugins: readonly PluginManifest[]): { bindings: Map<string, Map<string, string>>; failures: Map<string, Rejection[]> } {
  const bindings = new Map<string, Map<string, string>>();
  const failures = new Map<string, Rejection[]>();
  for (const m of plugins) {
    const bound = new Map<string, string>();
    const reasons: Rejection[] = [];
    for (const [contract, range, required] of dependencies(m)) {
      const providers = plugins.filter((p) => p.id !== m.id && providesMatching(p, contract, range)).map((p) => p.id);
      if (providers.length > 1) reasons.push({ kind: 'ambiguous', contract, providers });
      else if (providers[0] !== undefined) bound.set(contract, providers[0]);
      else if (required) reasons.push({ kind: 'missing', contract, range });
    }
    if (reasons.length === 0) bindings.set(m.id, bound);
    else failures.set(m.id, reasons);
  }
  return { bindings, failures };
}

/**
 * Какие отказы прохода окончательны. Нехватка поставщика (`missing`) - все такие плагины, с одними этими причинами. Нет нехватки -
 * неоднозначности, кроме тех, у кого спорный поставщик сам в отказе: после его ухода спор мог исчезнуть. Остались одни такие
 * (замкнутый спор) - отказ всем, иначе проход не сдвинулся бы.
 */
function settle(failures: ReadonlyMap<string, readonly Rejection[]>): [string, readonly Rejection[]][] {
  const all = [...failures];
  const lacking = all.filter(([, reasons]) => reasons.some((r) => r.kind === 'missing'));
  if (lacking.length > 0) return lacking.map(([id, reasons]) => [id, reasons.filter((r) => r.kind === 'missing')]);
  const final = all.filter(([, reasons]) => !reasons.some((r) => r.kind === 'ambiguous' && r.providers.some((p) => failures.has(p))));
  return final.length > 0 ? final : all;
}

function* dependencies(m: PluginManifest): Generator<[string, string, boolean]> {
  for (const [c, r] of Object.entries(m.requires)) yield [c, r, true];
  for (const [c, r] of Object.entries(m.optional)) yield [c, r, false];
}

export function providesMatching(m: PluginManifest, contract: string, range: string): boolean {
  return (own(m.provides, contract) ?? []).some((v) => satisfies(v, range));
}

/** Компоненты сильной связности размером больше одного (Тарьян). */
function findCycles(bindings: ReadonlyMap<string, ReadonlyMap<string, string>>): string[][] {
  const index = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let counter = 0;

  const visit = (v: string): number => {
    const own = counter++;
    let low = own;
    index.set(v, own);
    stack.push(v);
    onStack.add(v);
    for (const w of bindings.get(v)?.values() ?? []) {
      const seen = index.get(w);
      if (seen === undefined) low = Math.min(low, visit(w));
      else if (onStack.has(w)) low = Math.min(low, seen);
    }
    if (low === own) {
      const component: string[] = [];
      for (let w = stack.pop(); w !== undefined; w = stack.pop()) {
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      if (component.length > 1) cycles.push(component.reverse());
    }
    return low;
  };

  for (const v of bindings.keys()) if (!index.has(v)) visit(v);
  return cycles;
}

/** Кан с устойчивым порядком: среди готовых первым идёт тот, кто раньше во входе. */
function topoOrder(plugins: readonly PluginManifest[], bindings: ReadonlyMap<string, ReadonlyMap<string, string>>): string[] {
  const pending = new Map(plugins.map((m) => [m.id, new Set(bindings.get(m.id)?.values() ?? [])]));
  const order: string[] = [];
  while (pending.size > 0) {
    const next = [...pending].find(([, deps]) => deps.size === 0)?.[0];
    if (next === undefined) throw new Error('граф с циклом после отсева циклов');
    pending.delete(next);
    order.push(next);
    for (const deps of pending.values()) deps.delete(next);
  }
  return order;
}

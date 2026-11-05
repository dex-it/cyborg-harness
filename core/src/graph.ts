import type { PluginManifest } from './manifest.ts';
import { satisfies } from './semver.ts';
import { own } from './wire.ts';

export type Rejection =
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'engines'; readonly range: string; readonly api: string }
  | { readonly kind: 'missing'; readonly contract: string; readonly range: string }
  | { readonly kind: 'ambiguous'; readonly contract: string; readonly providers: readonly string[] }
  | { readonly kind: 'cycle'; readonly members: readonly string[] };

export interface ContractGraph {
  /** Порядок активации: поставщик раньше потребителя по requires и optional. */
  readonly order: readonly string[];
  readonly rejected: ReadonlyMap<string, readonly Rejection[]>;
  /** Потребитель -> контракт -> поставщик для requires и найденных optional. */
  readonly bindings: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** Решает граф по одним манифестам, до запуска кода. Отказ каскадирует до неподвижной точки. */
export function resolveGraph(manifests: readonly PluginManifest[], apiVersion: string): ContractGraph {
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
  }

  const alive = () => [...byId.values()].filter((m) => !rejected.has(m.id));
  let bindings: Map<string, Map<string, string>>;

  for (;;) {
    bindings = bindAll(alive(), reject);
    if (alive().length !== bindings.size) continue;
    const cycles = findCycles(bindings);
    if (cycles.length === 0) break;
    for (const members of cycles) for (const id of members) reject(id, { kind: 'cycle', members });
  }

  return { order: topoOrder(alive(), bindings), rejected, bindings };
}

/** Один проход: каждому живому - поставщики; отказавшие в этом проходе выпадают в следующем. */
function bindAll(plugins: readonly PluginManifest[], reject: (id: string, r: Rejection) => void): Map<string, Map<string, string>> {
  const bindings = new Map<string, Map<string, string>>();
  for (const m of plugins) {
    const bound = new Map<string, string>();
    let ok = true;
    for (const [contract, range, required] of dependencies(m)) {
      const providers = plugins.filter((p) => p.id !== m.id && providesMatching(p, contract, range)).map((p) => p.id);
      if (providers.length > 1) {
        reject(m.id, { kind: 'ambiguous', contract, providers });
        ok = false;
      } else if (providers[0] !== undefined) {
        bound.set(contract, providers[0]);
      } else if (required) {
        reject(m.id, { kind: 'missing', contract, range });
        ok = false;
      }
    }
    if (ok) bindings.set(m.id, bound);
  }
  return bindings;
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

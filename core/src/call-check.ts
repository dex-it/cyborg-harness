import type { KernelContext } from './kernel-context.ts';
import { satisfies } from './semver.ts';
import { guardedValue, guardsOf } from './via-contract.ts';
import { own } from './wire.ts';

/** Те же правила, что у ContractRegistry в хосте: requires и optional - только связанный графом поставщик, consumes - любой подходящей версии. */
export function mayUse(ctx: KernelContext, caller: string, provider: string, contract: string, version: string): boolean {
  const m = ctx.byId.get(caller);
  if (!m || caller === provider) return false;
  const one = own(m.requires, contract) ?? own(m.optional, contract);
  if (one !== undefined) return ctx.graph.bindings.get(caller)?.get(contract) === provider && satisfies(version, one);
  const many = own(m.consumes, contract);
  return many !== undefined && satisfies(version, many);
}

/**
 * Общая точка вызова члена контракта (`invoke` из главной части и `callAs` из вида).
 * `via-contract`: право вызывающего на аргументы члена, как их объявил поставщик; выполнит вызов поставщик по своим правам.
 * Член с `@deprecated` в манифесте поставщика пишется в журнал, когда проверки пройдены: отклонённый вызов ничего не вызвал.
 */
export async function checkCall(ctx: KernelContext, caller: string, provider: string, contract: string, member: string, args: readonly unknown[]): Promise<void> {
  const method = `${contract}.${member}`;
  for (const g of guardsOf(ctx.manifestOf(provider).guards, contract, member)) await ctx.gateway.checkFor(ctx.manifestOf(caller), method, g.right, guardedValue(args, g, method));
  if (own(ctx.manifestOf(provider).deprecated, contract)?.includes(member)) ctx.record({ pluginId: caller, kind: 'deprecated-call', provider, contract, member });
}

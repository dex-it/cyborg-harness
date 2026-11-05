import { CoreError } from './errors.ts';
import { isRecord } from './wire.ts';

/** Право, которое член контракта требует у вызывающего на свой аргумент (SAD2 §3.7, `via-contract`). */
export const GUARD_RIGHTS = ['fs.read', 'fs.write', 'shell', 'secrets.ref'] as const;
export type GuardRight = (typeof GUARD_RIGHTS)[number];

/** `arg` - номер аргумента, `field` - поле объекта в нём: `{ "fs.read": "0.path" }`. */
export interface Guard {
  readonly right: GuardRight;
  readonly arg: number;
  readonly field?: string;
}

/** Член контракта -> права на его аргументы. */
export type MemberGuards = Readonly<Record<string, readonly Guard[]>>;

/** Права члена из манифеста поставщика; член без записи ядро не проверяет. */
export function guardsOf(declared: Readonly<Record<string, MemberGuards>> | undefined, contract: string, member: string): readonly Guard[] {
  const forContract = declared?.[contract];
  return forContract !== undefined && Object.hasOwn(forContract, member) ? (forContract[member] ?? []) : [];
}

const ARG = /^(\d{1,2})(?:\.([A-Za-z_$][\w$]*))?$/;

export function readGuard(field: string, raw: unknown, errors: string[]): MemberGuards | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push(`${field}: ожидается объект член -> { право: аргумент }`);
    return undefined;
  }
  const out: Record<string, Guard[]> = {};
  for (const [member, rights] of Object.entries(raw)) {
    if (!isRecord(rights) || Object.keys(rights).length === 0) {
      errors.push(`${field}.${member}: ожидается { право: номер аргумента или "номер.поле" }`);
      continue;
    }
    const list: Guard[] = [];
    for (const [right, at] of Object.entries(rights)) {
      if (!(GUARD_RIGHTS as readonly string[]).includes(right)) {
        errors.push(`${field}.${member}.${right}: право не для аргумента - допустимы ${GUARD_RIGHTS.join(', ')}`);
        continue;
      }
      const match = typeof at === 'number' ? (Number.isInteger(at) && at >= 0 && at < 100 ? [String(at), String(at)] : null) : typeof at === 'string' ? ARG.exec(at) : null;
      if (!match?.[1]) {
        errors.push(`${field}.${member}.${right}: ожидается номер аргумента или "номер.поле"`);
        continue;
      }
      list.push({ right: right as GuardRight, arg: Number(match[1]), ...(match[2] !== undefined && { field: match[2] }) });
    }
    out[member] = list;
  }
  return out;
}

/** Значение аргумента под проверкой; не строка - отказ, а не пропуск: иначе проверку обошёл бы объект вместо пути. */
export function guardedValue(args: readonly unknown[], guard: Guard, method: string): string {
  const arg = args[guard.arg];
  const value = guard.field === undefined ? arg : isRecord(arg) && Object.hasOwn(arg, guard.field) ? arg[guard.field] : undefined;
  if (typeof value !== 'string') {
    const where = guard.field === undefined ? `аргумент ${guard.arg}` : `поле ${guard.field} аргумента ${guard.arg}`;
    throw new CoreError('Invalid', `${method}: ${where} должен быть строкой - его проверяет право ${guard.right}`);
  }
  return value;
}

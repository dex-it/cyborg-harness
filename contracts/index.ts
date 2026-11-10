import type { Agent, AgentTool } from './agent.ts';
import type { Git } from './git.ts';
import type { TreeDecoration } from './tree.ts';
import type { Sessions } from './sessions.ts';

/** Карта контрактов: имя -> мажорная версия -> тип; правила дополнения - README.md рядом. */
export interface Contracts {
  'cyborg.agent': { 1: Agent };
  'cyborg.agent-tool': { 1: AgentTool };
  'cyborg.session-prompt': { 1: SessionPrompt };
  /** Черновик PL-04. */
  'cyborg.git': { 1: Git };
  /** Черновик PL-04. */
  'cyborg.tree-decoration': { 1: TreeDecoration };
  /** Черновик пилота PL-02: только события сессий (`contracts/sessions.ts`). */
  'cyborg.sessions': { 1: Sessions };
}

export type * from './plugin.ts';
export type * from './view.ts';
export type * from './os.ts';
export type * from './agent.ts';
export type * from './git.ts';
export type * from './tree.ts';
export type * from './sessions.ts';
export type * from './elements.ts';

/** Ответ метода-подписки: снятие идёт поставщику через ядро, а при выгрузке любой из сторон ядро снимает подписку само. */
export interface Subscription {
  dispose(): void;
}

/** Кратность many (ADR-CH-0004, п. 6): потребитель сессий собирает фрагменты всех поставщиков и передаёт в `launch({ promptFragments })`. */
export interface SessionPrompt {
  /** Пустая строка - вклада нет. */
  fragment(): string;
}

export type ContractName = Extract<keyof Contracts, string>;
export type Major<K extends ContractName> = keyof Contracts[K] & number;
/** Версия, которую отдаёт поставщик: мажорная часть - из объявленных, дальше минорная и патч. */
export type VersionOf<K extends ContractName> = `${Major<K>}.${number}`;
export type MajorOf<V extends string> = V extends `${infer M extends number}.${string}` ? M : never;
export type ContractType<K extends ContractName, M extends Major<K>> = Contracts[K][M];

/** Контракт глазами потребителя: метод идёт через границу хоста и всегда асинхронный, данные - снимок на момент provide. */
export type Remote<T> = { readonly [P in keyof T]: RemoteMember<T[P]> };
type RemoteMember<X> = X extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : X;

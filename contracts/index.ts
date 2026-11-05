import type { Agent } from './agent.ts';

/** Карта контрактов: имя -> мажорная версия -> тип; правила дополнения - README.md рядом. */
export interface Contracts {
  'cyborg.agent': { 1: Agent };
  'cyborg.files': { 1: FilesV1; 2: FilesV2 };
  'cyborg.lock': { 1: Lock };
  'cyborg.projects': { 1: Projects };
  'cyborg.session-prompt': { 1: SessionPrompt };
  'cyborg.tab': { 1: Tab };
}

export type * from './plugin.ts';
export type * from './view.ts';
export type * from './os.ts';
export type * from './agent.ts';
export type * from './elements.ts';

/** Ответ метода-подписки: снятие идёт поставщику через ядро, а при выгрузке любой из сторон ядро снимает подписку само. */
export interface Subscription {
  dispose(): void;
}

export interface FilesV1 {
  read(path: string): Promise<string | undefined>;
  list(): Promise<string[]>;
}

export interface FileText {
  readonly path: string;
  readonly text: string;
  readonly size: number;
}

/** 2.0 ломает 1.x: `read` и `list` ушли, текст приходит с размером. */
export interface FilesV2 {
  readText(path: string): Promise<FileText | undefined>;
}

export interface Lock {
  isLocked(): Promise<boolean>;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface Projects {
  list(): Promise<Project[]>;
  current(): Promise<Project | undefined>;
}

/** Кратность many (ADR-CH-0004, п. 6): потребитель сессий собирает фрагменты всех поставщиков и передаёт в `launch({ promptFragments })`. */
export interface SessionPrompt {
  /** Пустая строка - вклада нет. */
  fragment(): string;
}

export interface Tab {
  readonly kind: string;
  /** С 1.1. */
  readonly icon?: string;
  open(path: string): Promise<string>;
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

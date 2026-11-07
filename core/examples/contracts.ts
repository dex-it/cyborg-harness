import type { Subscription } from '@cyborg-harness/contracts';

// Пакет объявлений стороннего автора: контракты demo.* дополняют карту, не трогая @cyborg-harness/contracts.
declare module '@cyborg-harness/contracts' {
  interface Contracts {
    'demo.clock': { 1: Clock };
    'demo.files': { 1: FilesV1; 2: FilesV2 };
    'demo.flaky': { 1: Flaky };
    'demo.lock': { 1: Lock };
    'demo.projects': { 1: Projects };
    'demo.tab': { 1: Tab };
  }
}

/** Нарочно нарушает правила контракта: граница хоста делает nowSync асинхронным; onTick - подписка по правилам. */
export interface Clock {
  nowSync(): number;
  now(): Promise<Date>;
  onTick(callback: (tick: number) => void): Subscription;
}

export interface Flaky {
  readonly pid: number;
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

export interface Tab {
  readonly kind: string;
  /** С 1.1. */
  readonly icon?: string;
  open(path: string): Promise<string>;
}

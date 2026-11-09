import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface Sandbox {
  /** Каталог после `realpath`: шлюз `ctx.os` отдаёт пути именно так. */
  readonly root: string;
  /** Путь внутри песочницы. */
  path(...parts: string[]): string;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Временный каталог, снимаемый через `await using`. На macOS `tmpdir()` - симлинк `/var` -> `/private/var`, поэтому без `realpath` пути не совпали бы с областями шлюза. */
export async function sandbox(prefix = 'cyborg-test-'): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  return {
    root,
    path: (...parts) => path.join(root, ...parts),
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  };
}

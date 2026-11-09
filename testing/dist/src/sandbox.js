import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
/** Временный каталог, снимаемый через `await using`. На macOS `tmpdir()` - симлинк `/var` -> `/private/var`, поэтому без `realpath` пути не совпали бы с областями шлюза. */
export async function sandbox(prefix = 'cyborg-test-') {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
    return {
        root,
        path: (...parts) => path.join(root, ...parts),
        [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
    };
}

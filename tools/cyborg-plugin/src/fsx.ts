import fs from 'node:fs/promises';
import path from 'node:path';

/** `target` лежит внутри `dir` или совпадает с ним. */
export const inside = (dir: string, target: string): boolean => target === dir || target.startsWith(dir + path.sep);

export const toPosix = (p: string): string => p.split(path.sep).join('/');

/** realpath существующей части пути: `/var` и `/private/var` на macOS иначе дали бы разные пути одного каталога. */
export async function realpathLoose(p: string): Promise<string> {
  const abs = path.resolve(p);
  try {
    return await fs.realpath(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(await realpathLoose(parent), path.basename(abs));
  }
}

/** Файлы каталога, пути от него через `/`, по алфавиту (порядок не зависит от ОС). Скрытые каталоги и `node_modules` пропускаются. */
export async function listFiles(root: string, skip: (rel: string, isDir: boolean) => boolean = () => false): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, full));
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.') && !skip(rel, true)) await walk(full);
      } else if (entry.isFile() && !skip(rel, false)) out.push(rel);
    }
  };
  await walk(root);
  return out;
}

export async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false,
  );
}

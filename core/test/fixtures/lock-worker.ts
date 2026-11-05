import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { lockWorkspace } from '../../src/workspace.ts';

interface Data {
  readonly shared: SharedArrayBuffer;
  readonly pid: number;
  readonly workers: number;
  readonly rounds: number;
  readonly dir: string;
}

/** Участник гонки за замок: на каждом раунде все потоки одновременно берут замок нового файла и сообщают, кто взял. */
const { shared, pid, workers, rounds, dir } = workerData as Data;
const ctl = new Int32Array(shared);
const won: number[] = [];
for (let r = 0; r < rounds; r++) {
  // Барьер на Atomics: счётчик пришедших в ctl[0], номер раунда в ctl[1].
  if (Atomics.add(ctl, 0, 1) + 1 === workers) {
    Atomics.store(ctl, 0, 0);
    Atomics.add(ctl, 1, 1);
  } else {
    while (Atomics.load(ctl, 1) <= r) {
      // Активное ожидание: барьер нужен на микросекунды.
    }
  }
  try {
    won.push(lockWorkspace(path.join(dir, `ws${String(r)}.json`), pid).ok ? 1 : 0);
  } catch {
    won.push(0);
  }
}
parentPort?.postMessage(won);

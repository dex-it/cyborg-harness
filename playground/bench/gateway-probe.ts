import fs from 'node:fs';
import path from 'node:path';

/** Замер шлюза `ctx.os` (T-07): одни и те же циклы идут из плагина, через `OsGateway.call` и голым действием - меняется только `ProbeOs`. */
export interface ProbeOs {
  readText(file: string): Promise<string>;
  watch(dir: string, listener: () => void): Promise<() => Promise<unknown>>;
  pty(): Promise<ProbePty>;
  setSecret(key: string, value: string): Promise<void>;
  secret(key: string): Promise<string | undefined>;
  fetch(url: string): Promise<string>;
}

export interface ProbePty {
  write(data: string): Promise<unknown>;
  onData(listener: (chunk: string) => void): void;
  kill(): Promise<unknown>;
}

export type ProbePath = 'fs.readText' | 'fs.readText.cold' | 'fs.watch' | 'pty.write' | 'secrets.get' | 'net.fetch' | 'net.fetch.checked';

export interface Sampled {
  /** Первый вызов, до разогрева. */
  readonly first: number;
  readonly times: number[];
}

export const WARMUP = 30;
export const SAMPLES = 300;
/** Эхо без дисциплины линии: в каноническом режиме строка длиннее 4 КиБ обрезалась бы, а эхо tty удвоило бы вывод. */
export const PTY_SCRIPT = 'stty raw -echo; printf R; exec cat';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Разгон и замер: `op(i)` - одно действие, `settle` после него в замер не входит; первый вызов отдельно, как холодный путь. */
async function loop(op: (i: number) => Promise<void>, settle?: () => Promise<unknown>): Promise<Sampled> {
  let first = NaN;
  const times: number[] = [];
  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    const t = performance.now();
    await op(i);
    const ms = performance.now() - t;
    if (i === 0) first = ms;
    if (i >= WARMUP) times.push(ms);
    await settle?.();
  }
  return { first, times };
}

function expectSize(text: string | undefined, size: number, what: string): void {
  if (text?.length !== size) throw new Error(`${what}: ждали ${String(size)} знаков, пришло ${String(text?.length)}`);
}

/** `target`: файл, каталог с файлами `0..329` (холодный путь), каталог слежения или адрес. */
export async function measure(os: ProbeOs, probe: ProbePath, target: string, size: number): Promise<Sampled> {
  switch (probe) {
    case 'fs.readText':
      return loop(async () => expectSize(await os.readText(target), size, probe));
    case 'fs.readText.cold':
      return loop(async (i) => expectSize(await os.readText(path.join(target, String(i))), size, probe));
    case 'fs.watch': {
      // Дописывание - одно событие inotify: запись с обрезкой дала бы два, и хвост пачки попал бы в следующий замер.
      const file = path.join(target, 'w.txt');
      fs.writeFileSync(file, '');
      let arrived: (() => void) | undefined;
      const dispose = await os.watch(target, () => arrived?.());
      await sleep(100);
      const payload = 'w'.repeat(size);
      try {
        return await loop(async () => {
          const got = new Promise<void>((r) => (arrived = r));
          fs.appendFileSync(file, payload);
          await got;
          arrived = undefined;
        }, () => sleep(5));
      } finally {
        await dispose();
      }
    }
    case 'pty.write': {
      const pty = await os.pty();
      let buffer = '';
      let want = 'R';
      let arrived: (() => void) | undefined;
      pty.onData((chunk) => {
        buffer += chunk;
        if (buffer.endsWith(want)) arrived?.();
      });
      const ready = new Promise<void>((r) => (arrived = r));
      if (!buffer.endsWith(want)) await ready;
      let echoed = Promise.resolve();
      try {
        // Цена - сам вызов; эхо ждётся вне замера, чтобы следующая запись не стояла в очереди за выводом прежней.
        return await loop(
          async (i) => {
            want = `#${String(i)}$`;
            buffer = '';
            echoed = new Promise<void>((r) => (arrived = r));
            await pty.write('x'.repeat(Math.max(0, size - want.length)) + want);
          },
          () => echoed,
        );
      } finally {
        await pty.kill();
      }
    }
    case 'secrets.get':
      await os.setSecret(target, 's'.repeat(size));
      return loop(async () => expectSize(await os.secret(target), size, probe));
    case 'net.fetch':
    case 'net.fetch.checked':
      return loop(async () => expectSize(await os.fetch(target), size, probe));
  }
}

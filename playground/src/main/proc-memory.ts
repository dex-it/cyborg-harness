// Память процесса для замеров: на Linux - PSS и RSS из /proc, на macOS - физический след (`footprint`) и RSS из `ps`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const UNIT_KB: Record<string, number> = { B: 1 / 1024, KB: 1, MB: 1024, GB: 1024 * 1024 };

/** Килобайты из строки вида «Footprint: 14 MB (16384 bytes per page)». */
export function parseFootprintKb(output: string): number | undefined {
  const m = /Footprint:\s+([\d.]+)\s*(B|KB|MB|GB)\b/.exec(output);
  const unit = m?.[2] === undefined ? undefined : UNIT_KB[m[2]];
  return m?.[1] === undefined || unit === undefined ? undefined : Math.round(Number(m[1]) * unit);
}

/** PSS на Linux (общие страницы поделены между процессами и складываются); на macOS - footprint, другая мера. */
export function pssKb(pid: number): number | undefined {
  try {
    if (process.platform === 'darwin') return parseFootprintKb(execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8', timeout: 10_000 }));
    const kb = /^Pss:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${String(pid)}/smaps_rollup`, 'utf8'))?.[1];
    return kb === undefined ? undefined : Number(kb);
  } catch {
    return undefined;
  }
}

export function rssKb(pid: number): number | undefined {
  try {
    if (process.platform === 'darwin') {
      const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 }).trim());
      return Number.isFinite(kb) && kb > 0 ? kb : undefined;
    }
    const kb = /^VmRSS:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${String(pid)}/status`, 'utf8'))?.[1];
    return kb === undefined ? undefined : Number(kb);
  } catch {
    return undefined;
  }
}

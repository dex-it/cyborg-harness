import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { ConfinePolicy, ConfinerLauncher, ConfinerStatus } from './confiner.ts';

// TR-22b (ADR-CH-0019, п. 6): Linux. Запускатель `cyborg-confine` (electron/native/cyborg-confine.c, около 300 строк C без зависимостей) накладывает no_new_privs, Landlock по версии ABI
// ядра и seccomp, затем запускает Node. Вариант выбран из решения исследования (5.13): маленький запускатель вместо аддона (аддон под `--permission` запрещён самому хосту и нужен
// был бы в процессе ядра) и вместо bubblewrap (user namespaces Ubuntu 24.04 ограничивает AppArmor).

/** Что запускатель сообщил о ядре (`cyborg-confine --probe`). */
export interface LandlockProbe {
  readonly abi: number;
  readonly seccomp: boolean;
  readonly arch: string;
  readonly kernel: string;
}

/** Что хост читает всегда: загрузчик и системные библиотеки (их также исполняет ядро при запуске), конфигурация OpenSSL (Node читает её при старте), сведения о процессоре и cgroup. */
const SYSTEM_EXEC: readonly string[] = ['/lib', '/lib64', '/usr/lib', '/usr/lib64'];
const SYSTEM_READ: readonly string[] = ['/etc/ld.so.cache', '/etc/ssl/openssl.cnf', '/usr/local/ssl/openssl.cnf', '/proc/self', '/sys/devices/system/cpu', '/sys/fs/cgroup'];

export function parseProbe(text: string): LandlockProbe | undefined {
  try {
    const raw = JSON.parse(text) as Partial<LandlockProbe>;
    if (typeof raw.abi !== 'number' || typeof raw.seccomp !== 'boolean' || typeof raw.arch !== 'string' || typeof raw.kernel !== 'string') return undefined;
    return { abi: raw.abi, seccomp: raw.seccomp, arch: raw.arch, kernel: raw.kernel };
  } catch {
    return undefined;
  }
}

/** Что запускатель закроет на этом ядре, словами. Слои, которых ядро не даёт, названы: человек читает это в окне. */
export function describeProbe(probe: LandlockProbe): ConfinerStatus {
  if (!probe.seccomp) return { ok: false, reason: `ядро ${probe.kernel} (${probe.arch}): seccomp недоступен, сокеты закрыть нечем` };
  const net = 'сокеты не создаются (seccomp), fork и запуск программ закрыты, no_new_privs';
  if (probe.abi < 1) return { ok: true, files: false, summary: `${net}; Landlock недоступен (ядро ${probe.kernel}, ABI 0): чтение файлов вне каталога плагина ограничено только запретами Node` };
  const layers = [
    probe.abi >= 4 ? 'TCP bind и connect закрыты Landlock' : 'правил TCP Landlock в этом ядре нет (ABI < 4, ядро до 6.7): сеть закрыта одним seccomp',
    probe.abi >= 6 ? 'абстрактные unix-сокеты и сигналы наружу закрыты' : undefined,
  ].filter((x): x is string => x !== undefined);
  return { ok: true, files: true, summary: `Landlock ABI ${String(probe.abi)} (ядро ${probe.kernel}): чтение файлов вне каталога плагина и запись закрыты; ${net}; ${layers.join('; ')}` };
}

export function landlockConfiner(binary: string): ConfinerLauncher {
  const status = ((): ConfinerStatus => {
    if (!fs.existsSync(binary)) return { ok: false, reason: `запускатель ${binary} не найден (сборка: npm run build:confiner)` };
    const run = spawnSync(binary, ['--probe'], { encoding: 'utf8', timeout: 5000 });
    if (run.status !== 0) return { ok: false, reason: `${binary} --probe: ${run.error?.message ?? (run.stderr.trim() || `код ${String(run.status)}`)}` };
    const probe = parseProbe(run.stdout);
    return probe === undefined ? { ok: false, reason: `${binary} --probe ответил не по форме: ${run.stdout.trim().slice(0, 200)}` } : describeProbe(probe);
  })();
  return {
    name: 'landlock+seccomp',
    status,
    wrap: ({ command, args }, policy: ConfinePolicy) => ({
      command: binary,
      args: [...[...SYSTEM_READ, ...policy.read].map((p) => `--read=${p}`), ...[...SYSTEM_EXEC, ...policy.exec].map((p) => `--exec=${p}`), '--', command, ...args],
    }),
  };
}

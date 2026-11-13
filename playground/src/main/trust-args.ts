import type { TrustOptions } from '@cyborg-harness/electron';
import type { IsolationSettings } from '@cyborg-harness/electron/isolation';

// TR-11, TR-12 (ADR-CH-0017): проверка происхождения пакетов в стенде включается только командной строкой, как `--user-plugins`: файл воркспейса приходит из репозитория
// команды и не может ни включить проверку, ни выключить её. Без флагов стенд ведёт себя как раньше (пакеты не проверяются).
//   --release-key=ed25519:…        открытый ключ выпуска (можно несколько): ими проверяется delivery.json и пакеты каталога пользователя
//   --delivery-signatures=<режим>  off | warn | enforce для встроенных плагинов (по умолчанию warn, когда проверка включена)
//   --plugin-signatures=<режим>    то же для каталога пользователя (по умолчанию enforce)
export const RELEASE_KEY_FLAG = '--release-key=';
export const DELIVERY_SIGNATURES_FLAG = '--delivery-signatures=';
export const PLUGIN_SIGNATURES_FLAG = '--plugin-signatures=';

const MODES = new Set(['off', 'warn', 'enforce']);

const valuesOf = (argv: readonly string[], flag: string): string[] => argv.filter((a) => a.startsWith(flag)).map((a) => a.slice(flag.length));

export interface TrustArgs {
  readonly trust?: TrustOptions;
  readonly error?: string;
}

/** Настройки проверки из командной строки; `trust` нет, если ни одного флага не дано. */
export function trustFromArgv(argv: readonly string[]): TrustArgs {
  const releaseKeys = valuesOf(argv, RELEASE_KEY_FLAG);
  const delivery = valuesOf(argv, DELIVERY_SIGNATURES_FLAG).at(-1);
  const user = valuesOf(argv, PLUGIN_SIGNATURES_FLAG).at(-1);
  if (releaseKeys.length === 0 && delivery === undefined && user === undefined) return {};
  for (const [flag, mode] of [[DELIVERY_SIGNATURES_FLAG, delivery], [PLUGIN_SIGNATURES_FLAG, user]] as const) {
    if (mode !== undefined && !MODES.has(mode)) return { error: `${flag}${mode}: ожидается off, warn или enforce` };
  }
  const modes = {
    ...(delivery !== undefined && { bundled: delivery as 'off' | 'warn' | 'enforce' }),
    ...(user !== undefined && { user: user as 'off' | 'warn' | 'enforce' }),
  };
  return { trust: { releaseKeys, modes } };
}

// TR-21, TR-22 (ADR-CH-0019): способ запуска сторонних плагинов - тоже только командная строка (файл воркспейса не должен ни включить изоляцию, ни снять её).
//   --node-host=<бинарник Node>       сторонние плагины - процесс Node под запретами (без флага - utilityProcess, уровень 1)
//   --third-party-host=utility|node   возврат на utilityProcess одной настройкой, даже если задан --node-host
//   --confiner=auto|off               ограничитель ОС (по умолчанию auto: Seatbelt на macOS, запускатель Linux)
//   --confiner-bin=<cyborg-confine>   запускатель Linux (сборка: npm run build:confiner)
export const NODE_HOST_FLAG = '--node-host=';
export const THIRD_PARTY_HOST_FLAG = '--third-party-host=';
export const CONFINER_FLAG = '--confiner=';
export const CONFINER_BIN_FLAG = '--confiner-bin=';

/** Настройки изоляции из командной строки; `entry` - бандл `host-entry` ядра рядом с приложением. Неверное значение флага - исключение: приложение не стартует вполсилы. */
export function isolationFromArgv(argv: readonly string[], entry: string): IsolationSettings {
  const node = valuesOf(argv, NODE_HOST_FLAG).at(-1);
  const mode = valuesOf(argv, THIRD_PARTY_HOST_FLAG).at(-1);
  const confiner = valuesOf(argv, CONFINER_FLAG).at(-1);
  const bin = valuesOf(argv, CONFINER_BIN_FLAG).at(-1);
  if (mode !== undefined && mode !== 'utility' && mode !== 'node') throw new Error(`${THIRD_PARTY_HOST_FLAG}${mode}: ожидается utility или node`);
  if (confiner !== undefined && confiner !== 'auto' && confiner !== 'off') throw new Error(`${CONFINER_FLAG}${confiner}: ожидается auto или off`);
  return {
    ...(node !== undefined && { node: { binary: node, entry } }),
    ...(mode !== undefined && { thirdPartyHost: mode }),
    ...(confiner !== undefined && { confiner }),
    ...(bin !== undefined && { confinerBinary: bin }),
  };
}

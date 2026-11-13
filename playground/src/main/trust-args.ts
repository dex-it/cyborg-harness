import type { TrustOptions } from '@cyborg-harness/electron';

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

export type TrustArgs = { readonly trust?: TrustOptions; readonly error?: string };

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

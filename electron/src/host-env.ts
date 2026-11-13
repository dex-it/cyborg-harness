/**
 * Окружение хоста плагинов (TR-02, docs/research/trust-and-isolation): хост получает явный перечень переменных, а не `process.env` главного процесса.
 * Токены, `SSH_AUTH_SOCK`, `AWS_*` и прочее из окружения приложения коду плагина не достаются: плагин берёт что нужно через `ctx.os.env` по праву `env`.
 * Перечень минимальный и расширяется по доказательству (хост без переменной не работает), а не «на всякий случай»; список - в `electron/README.md`.
 */
export const HOST_ENV_KEYS: readonly string[] = ['PATH'];

/** Переменные хоста из окружения `source`: только названные в `HOST_ENV_KEYS` и только заданные. */
export function hostEnv(source: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HOST_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

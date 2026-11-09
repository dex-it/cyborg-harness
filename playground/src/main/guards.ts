// Мелкие помощники главного процесса. Ядро их не отдаёт (T-09): приложению это одна строка, а обещание совместимости - лишнее.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

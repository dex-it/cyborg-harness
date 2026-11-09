// Мелкий помощник приложения. Ядро и адаптер Electron его не отдают (T-09, P-03): приложению это одна строка, а обещание совместимости - лишнее.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

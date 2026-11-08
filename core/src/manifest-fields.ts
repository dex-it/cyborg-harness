/** Общие мелочи разбора манифеста: части `manifest-*.ts` и сам `manifest.ts` берут их отсюда, чтобы не импортировать друг друга по кругу. */
const ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

export const VIEW_NAME = /^[a-z][a-z0-9-]*$/;

export function isValidId(value: string): boolean {
  return ID.test(value);
}

export function show(value: unknown): string {
  return value === undefined ? 'ничего' : JSON.stringify(value);
}

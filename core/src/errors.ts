import type { CoreErrorCode } from '@cyborg-harness/contracts';

export type { CoreErrorCode };

export class CoreError extends Error {
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode, message: string) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

export interface WireError {
  readonly code: CoreErrorCode;
  readonly message: string;
}

export function toWire(error: unknown): WireError {
  if (error instanceof CoreError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'Remote', message: error.message };
  return { code: 'Remote', message: String(error) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Отказ уже учтён в другом месте - например, падение хоста фиксирует его журнал. */
export function ignore(): undefined {
  return undefined;
}

/** Ошибка пришла от другой стороны канала и формы не обещает. */
export function fromWire(error: unknown): CoreError {
  if (typeof error !== 'object' || error === null) return new CoreError('Remote', 'ошибка без формы');
  const { code, message } = error as Record<string, unknown>;
  if (typeof code !== 'string' || typeof message !== 'string') return new CoreError('Remote', 'ошибка без формы');
  return new CoreError(code as CoreErrorCode, message);
}

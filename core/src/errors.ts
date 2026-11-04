export type CoreErrorCode =
  | 'NotDeclared'
  | 'AlreadyProvided'
  | 'Unavailable'
  | 'NotCloneable'
  | 'Invalid'
  | 'CommandNotFound'
  | 'CommandConflict'
  | 'HostGone'
  | 'Timeout'
  | 'Remote';

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

export function fromWire(error: WireError): CoreError {
  return new CoreError(error.code, error.message);
}

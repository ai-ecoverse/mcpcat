export const EXIT_OK = 0;
export const EXIT_TOOL_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_CONNECTION = 3;
export const EXIT_AUTH = 4;
export const EXIT_RPC_ERROR = 5;
export const EXIT_INPUT_REQUIRED = 6;
export const EXIT_TIMEOUT = 124;
export const EXIT_INTERRUPTED = 130;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_TOOL_ERROR
  | typeof EXIT_USAGE
  | typeof EXIT_CONNECTION
  | typeof EXIT_AUTH
  | typeof EXIT_RPC_ERROR
  | typeof EXIT_INPUT_REQUIRED
  | typeof EXIT_TIMEOUT
  | typeof EXIT_INTERRUPTED;

export class McpcatError extends Error {
  readonly exitCode: ExitCode;
  constructor(exitCode: ExitCode, message: string) {
    super(message);
    this.name = 'McpcatError';
    this.exitCode = exitCode;
  }
}

export function usageError(message: string): McpcatError {
  return new McpcatError(EXIT_USAGE, message);
}

export function connectionError(message: string): McpcatError {
  return new McpcatError(EXIT_CONNECTION, message);
}

export function authError(message: string): McpcatError {
  return new McpcatError(EXIT_AUTH, message);
}

export function rpcError(message: string): McpcatError {
  return new McpcatError(EXIT_RPC_ERROR, message);
}

export function timeoutError(message: string): McpcatError {
  return new McpcatError(EXIT_TIMEOUT, message);
}

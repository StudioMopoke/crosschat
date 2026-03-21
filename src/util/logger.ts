const PREFIX = '[crosschat]';

export function log(message: string, ...args: unknown[]): void {
  console.error(`${PREFIX} ${message}`, ...args);
}

export function logError(message: string, error?: unknown): void {
  if (error instanceof Error) {
    console.error(`${PREFIX} ERROR: ${message}:`, error.message);
  } else {
    console.error(`${PREFIX} ERROR: ${message}`, error ?? '');
  }
}

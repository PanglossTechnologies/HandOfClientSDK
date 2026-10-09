/** The few methods the module needs; pino, winston, bunyan and `console` all fit. */
export interface Logger {
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

/** Default: warnings and errors to the console, per-call info logging off (pass your own logger to see it). */
export const defaultLogger: Logger = {
  info: () => undefined,
  warn: (m, ...meta) => console.warn(`[handofclient] ${m}`, ...meta),
  error: (m, ...meta) => console.error(`[handofclient] ${m}`, ...meta),
};

/** The error's stack plus every `cause` below it, so a log line never hides an inner exception. */
export function describeError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 8; depth++) {
    parts.push(cur instanceof Error ? cur.stack ?? `${cur.name}: ${cur.message}` : String(cur));
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return parts.join("\nCaused by: ");
}

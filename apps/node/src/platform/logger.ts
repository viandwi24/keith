/** The only place in apps/node that may touch the console. */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export function createLogger(prefix = 'keith-node'): Logger {
  const line = (level: string, message: string): string => `[${prefix}] ${level} ${message}`
  return {
    info: (message) => console.log(line('info', message)),
    warn: (message) => console.warn(line('warn', message)),
    error: (message) => console.error(line('error', message)),
  }
}

/** Plain output for command results (status, join hints). */
export function print(message: string): void {
  console.log(message)
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} }

import type { Clock, LogFields, Logger } from './types.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Keys whose values are never logged (docs/architecture/config.md#secrets). */
export const SECRET_KEY_PATTERN = /key|token|secret|password/i

export const REDACTED = '[redacted]'

const MAX_DEPTH = 8

/**
 * Returns a JSON-safe copy of `value` with every property whose key matches
 * `SECRET_KEY_PATTERN` replaced by `REDACTED`, at any depth. Errors become `{ name, message }`.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'function' || typeof value === 'symbol') return String(value)
    return value
  }
  if (depth >= MAX_DEPTH) return '[truncated]'
  if (value instanceof Error) {
    return { name: value.name, message: value.message }
  }
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : redactSecrets(v, depth + 1)
  }
  return out
}

export type LoggerOptions = {
  /** Lines below this level are dropped. Default 'info'. */
  level?: LogLevel | undefined
  clock: Clock
  /** Receives one JSON line (without newline). Default: stdout. */
  write?: ((line: string) => void) | undefined
  /** Fields added to every line. */
  fields?: LogFields | undefined
}

/**
 * A JSON-lines logger: `{"ts":…,"level":"info","msg":"…",…fields}`. Field values whose key looks
 * secret are redacted (R-14).
 */
export function createLogger(opts: LoggerOptions): Logger {
  const min = LEVEL_ORDER[opts.level ?? 'info']
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const make = (base: LogFields): Logger => {
    const log =
      (level: LogLevel) =>
      (msg: string, fields?: LogFields): void => {
        if (LEVEL_ORDER[level] < min) return
        const safe = redactSecrets({ ...base, ...fields }) as LogFields
        write(JSON.stringify({ ts: opts.clock.now(), level, msg, ...safe }))
      }
    return {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      child: (fields) => make({ ...base, ...fields }),
    }
  }
  return make(opts.fields ?? {})
}

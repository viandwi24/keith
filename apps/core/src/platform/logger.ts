import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config.ts'

const ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const
type Level = keyof typeof ORDER

/** Structured fields of one event; secrets in them are redacted before they reach a file. */
export type LogFields = Record<string, unknown>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

export interface FileLogger extends Logger {
  /**
   * Resolves when every queued line is on disk (tests, shutdown). With `timeoutMs` it resolves
   * after that many milliseconds at the latest, even when the disk is slow (shutdown cap).
   */
  flush(timeoutMs?: number): Promise<void>
  /**
   * Print a secret on the console only, unredacted and never to the log file. For the one
   * deliberate line that hands the owner a new token; nothing else may use it.
   */
  secretOnce(message: string): void
}

export interface LoggerOptions {
  level: Config['logLevel']
  /** Folder of the daily files. Without it nothing is written to disk. */
  dir?: string
  /** Clock (tests). Default `() => new Date()`. */
  now?: () => Date
  /** Daily files older than this many days are deleted. Default 14. */
  retainDays?: number
  /** Mirror events on the console. Default true. */
  console?: boolean
}

/** Keys whose value is never written, wherever they appear (substring match). */
const SECRET_KEY = /token|secret|key|authorization|password|passphrase|cookie/i
/**
 * Whole key names that are secret when they are a field of their own. `sessionId` and
 * `guestSession` are ids and stay (the dead-letter and guest lines need them).
 */
const SECRET_NAME = /^(pin|code|session)$/i
/** An eharness or Keith error code (`W_HOOK_FAILED`, `EH_CONFIG_INVALID`, `GUEST_AUDIT`). */
const ERROR_CODE = /^(?:E|W|EH|GUEST)_[A-Z0-9_]{2,60}$/
const REDACTED = '[redacted]'
const MAX_DEPTH = 6

/** True when a field must be masked. A `code` field keeps an error code (the guest line needs it). */
function isSecretField(key: string, value: unknown): boolean {
  if (SECRET_KEY.test(key)) return true
  if (!SECRET_NAME.test(key)) return false
  if (key.toLowerCase() === 'code' && typeof value === 'string' && ERROR_CODE.test(value))
    return false
  return true
}

/** Strings that look like a credential, wherever they appear. */
export function redactString(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"']+/gi, `Bearer ${REDACTED}`)
    .replace(/keith_[\w-]+/g, REDACTED)
    .replace(/sk-or-v1-[\w-]+/g, REDACTED)
    .replace(/\bsk-[\w-]{20,}/g, REDACTED)
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, REDACTED)
}

/** A copy of `value` with secret-looking keys and token-looking strings masked. */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  if (depth >= MAX_DEPTH) return '[truncated]'
  seen.add(value)
  if (value instanceof Error) return redactString(value.message)
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen))
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      isSecretField(k, v) ? REDACTED : redact(v, depth + 1, seen),
    ]),
  )
}

const pad = (n: number): string => String(n).padStart(2, '0')
/** Local calendar date `YYYY-MM-DD`. */
const dayOf = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const FILE = /^keith-(\d{4}-\d{2}-\d{2})\.log$/

function safeJson(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record)
  } catch {
    return JSON.stringify({ at: record.at, level: record.level, msg: record.msg })
  }
}

/**
 * The only module that writes to the console. Events go to the console as `level message` and,
 * with a `dir`, to `keith-YYYY-MM-DD.log` as one JSON line each (redacted). Writing is queued:
 * a log call never blocks and never throws; a folder that cannot be written falls back to the
 * console (once per failure streak).
 */
export function createLogger(input: LoggerOptions | Config['logLevel']): FileLogger {
  const options: LoggerOptions = typeof input === 'string' ? { level: input } : input
  const now = options.now ?? (() => new Date())
  const retainDays = options.retainDays ?? 14
  const toConsole = options.console ?? true
  const dir = options.dir

  let queue: { file: string; line: string }[] = []
  let draining: Promise<void> = Promise.resolve()
  let currentDay = ''
  let failing = false

  const sweep = async (today: Date): Promise<void> => {
    if (dir === undefined) return
    const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - retainDays)
    const limit = dayOf(cutoff)
    try {
      for (const name of await readdir(dir)) {
        const day = FILE.exec(name)?.[1]
        if (day !== undefined && day < limit) await unlink(join(dir, name)).catch(() => {})
      }
    } catch {
      // no folder yet, or unreadable: nothing to sweep
    }
  }

  const drain = async (): Promise<void> => {
    if (dir === undefined) return
    const batch = queue
    queue = []
    if (batch.length === 0) return
    const byFile = new Map<string, string>()
    for (const { file, line } of batch) byFile.set(file, `${byFile.get(file) ?? ''}${line}\n`)
    try {
      await mkdir(dir, { recursive: true })
      for (const [file, text] of byFile) await appendFile(join(dir, file), text)
      failing = false
    } catch (error) {
      if (!failing && toConsole) {
        console.error(
          `error log file not writable (${dir}): ${error instanceof Error ? error.message : error}`,
        )
      }
      failing = true
    }
  }

  const schedule = (): void => {
    draining = draining.then(drain, drain)
  }

  const write = (level: Level, message: string, fields?: LogFields): void => {
    if (ORDER[level] < ORDER[options.level]) return
    try {
      const date = now()
      const safe = fields === undefined ? undefined : (redact(fields) as LogFields)
      if (toConsole) {
        const extra =
          safe === undefined || Object.keys(safe).length === 0 ? '' : ` ${safeJson(safe)}`
        const out = level === 'debug' ? console.debug : console[level]
        out(`${level.padEnd(5)} ${redactString(message)}${extra}`)
      }
      if (dir === undefined) return
      const day = dayOf(date)
      if (day !== currentDay) {
        currentDay = day
        draining = draining.then(() => sweep(date)).catch(() => {})
      }
      queue.push({
        file: `keith-${day}.log`,
        line: safeJson({ ...safe, at: date.toISOString(), level, msg: redactString(message) }),
      })
      schedule()
    } catch {
      // logging must never break the caller
    }
  }

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    secretOnce(message) {
      if (toConsole) console.info(`${'info'.padEnd(5)} ${message}`)
    },
    async flush(timeoutMs) {
      schedule()
      if (timeoutMs === undefined) return draining
      let timer: ReturnType<typeof setTimeout> | undefined
      const cap = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })
      try {
        await Promise.race([draining, cap])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** A logger that drops everything (tests). */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

const WARNING_CODE = /\bW_[A-Z0-9_]+\b/

/**
 * The eharness logger interface over a Keith logger. Data becomes structured fields; an
 * eharness warning (`W_*` code in the message or in `data.code`) is always level warn, with its
 * code and details as fields.
 */
export function toHarnessLogger(logger: Logger): {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
} {
  const fieldsOf = (message: string, data?: Record<string, unknown>): LogFields | undefined => {
    const fromData = typeof data?.code === 'string' ? data.code : undefined
    const code = WARNING_CODE.exec(fromData ?? '')?.[0] ?? WARNING_CODE.exec(message)?.[0]
    if (code === undefined) return data
    const { details, code: _code, ...rest } = data ?? {}
    const nested =
      details !== null && typeof details === 'object' ? (details as Record<string, unknown>) : {}
    return { code, ...rest, ...nested }
  }
  const isWarning = (message: string, data?: Record<string, unknown>): boolean =>
    WARNING_CODE.test(message) || WARNING_CODE.test(String(data?.code ?? ''))
  return {
    debug: (m, d) => logger.debug(m, fieldsOf(m, d)),
    info: (m, d) =>
      isWarning(m, d) ? logger.warn(m, fieldsOf(m, d)) : logger.info(m, fieldsOf(m, d)),
    warn: (m, d) => logger.warn(m, fieldsOf(m, d)),
    error: (m, d) =>
      isWarning(m, d) ? logger.warn(m, fieldsOf(m, d)) : logger.error(m, fieldsOf(m, d)),
  }
}

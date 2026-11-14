import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createLogger, type LogFields, redact, redactString, toHarnessLogger } from './logger.ts'

const roots: string[] = []
const tmp = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'keith-log-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const lines = (file: string): Record<string, unknown>[] =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))

describe('file logger', () => {
  test('writes JSON lines to keith-YYYY-MM-DD.log with structured fields', async () => {
    const dir = join(tmp(), 'logs')
    const log = createLogger({
      level: 'info',
      dir,
      console: false,
      now: () => new Date(2026, 9, 26, 12, 0, 0),
    })
    log.debug('hidden')
    log.info('hello', { n: 1 })
    log.error('boom')
    await log.flush()
    expect(readdirSync(dir)).toEqual(['keith-2026-10-26.log'])
    const out = lines(join(dir, 'keith-2026-10-26.log'))
    expect(out.map((l) => l.msg)).toEqual(['hello', 'boom'])
    expect(out[0]).toMatchObject({ level: 'info', n: 1 })
    expect(typeof out[0]?.at).toBe('string')
  })

  test('rotates when the day changes', async () => {
    const dir = tmp()
    let day = 26
    const log = createLogger({
      level: 'info',
      dir,
      console: false,
      now: () => new Date(2026, 9, day, 23, 59),
    })
    log.info('a')
    await log.flush()
    day = 27
    log.info('b')
    await log.flush()
    expect(readdirSync(dir).sort()).toEqual(['keith-2026-10-26.log', 'keith-2026-10-27.log'])
  })

  test('deletes daily files older than the retention, keeps the rest', async () => {
    const dir = tmp()
    for (const name of [
      'keith-2026-10-01.log',
      'keith-2026-10-11.log',
      'keith-2026-10-12.log',
      'other.log',
    ])
      writeFileSync(join(dir, name), '')
    const log = createLogger({
      level: 'info',
      dir,
      console: false,
      retainDays: 14,
      now: () => new Date(2026, 9, 26, 8),
    })
    log.info('x')
    await log.flush()
    expect(readdirSync(dir).sort()).toEqual([
      'keith-2026-10-12.log',
      'keith-2026-10-26.log',
      'other.log',
    ])
  })

  test('never throws when the folder is unwritable; falls back to the console', async () => {
    const root = tmp()
    const blocker = join(root, 'file')
    writeFileSync(blocker, '')
    const seen: string[] = []
    const spy = spyOn(globalThis.console, 'error').mockImplementation((m: string) => {
      seen.push(m)
    })
    try {
      const log = createLogger({ level: 'info', dir: join(blocker, 'logs'), console: true })
      expect(() => log.error('still alive')).not.toThrow()
      await log.flush()
      expect(seen.some((e) => e.includes('still alive'))).toBe(true)
      expect(seen.some((e) => e.includes('not writable'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  test('keeps the legacy level-only signature', () => {
    expect(() => createLogger('error').debug('x')).not.toThrow()
  })
})

describe('redaction', () => {
  test('masks secret keys and token-looking strings', () => {
    expect(
      redact({
        apiKey: 'sk-1',
        nested: { Authorization: 'Bearer abc.def', password: 'p' },
        ok: 'fine',
        list: ['keith_AbC-123', 'x'],
      }),
    ).toEqual({
      apiKey: '[redacted]',
      nested: { Authorization: '[redacted]', password: '[redacted]' },
      ok: 'fine',
      list: ['[redacted]', 'x'],
    })
    expect(redactString('header Bearer abc123 and keith_tok_9 end')).toBe(
      'header Bearer [redacted] and [redacted] end',
    )
  })

  test('survives cycles', () => {
    const a: Record<string, unknown> = { x: 1 }
    a.self = a
    expect(redact(a)).toEqual({ x: 1, self: '[circular]' })
  })

  test('the file never holds a secret', async () => {
    const dir = tmp()
    const log = createLogger({
      level: 'info',
      dir,
      console: false,
      now: () => new Date(2026, 0, 5),
    })
    // built at runtime: a token-shaped literal would (rightly) trip gitleaks
    const secret = ['SECRET', crypto.randomUUID().slice(0, 8)].join('')
    const token = `keith_${secret}`
    log.info(`owner token ${token}`, { token, header: 'Bearer zzz' })
    await log.flush()
    const text = readFileSync(join(dir, 'keith-2026-01-05.log'), 'utf8')
    expect(text).not.toContain(secret)
    expect(text).not.toContain('zzz')
  })
})

describe('toHarnessLogger', () => {
  const capture = () => {
    const events: { level: string; message: string; fields?: LogFields }[] = []
    const record = (level: string) => (message: string, fields?: LogFields) =>
      void events.push({ level, message, ...(fields === undefined ? {} : { fields }) })
    const logger = {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    }
    return { events, harness: toHarnessLogger(logger) }
  }

  test('a W_* warning keeps level warn with its code and details', () => {
    const { events, harness } = capture()
    harness.warn('W_TOOL_SOURCE_FAILED: list failed', { details: { source: 'mcp' } })
    expect(events[0]).toEqual({
      level: 'warn',
      message: 'W_TOOL_SOURCE_FAILED: list failed',
      fields: { code: 'W_TOOL_SOURCE_FAILED', source: 'mcp' },
    })
  })

  test('a W_* code on another level is raised to warn; code in data counts', () => {
    const { events, harness } = capture()
    harness.info('compaction skipped', { code: 'W_COMPACTION_FAILED', details: { a: 1 } })
    harness.error('W_HOOK_FAILED in hook')
    expect(events.map((e) => e.level)).toEqual(['warn', 'warn'])
    expect(events[0]?.fields).toEqual({ code: 'W_COMPACTION_FAILED', a: 1 })
  })

  test('plain events keep their level and data', () => {
    const { events, harness } = capture()
    harness.info('hi', { a: 1 })
    harness.error('bad')
    expect(events).toEqual([
      { level: 'info', message: 'hi', fields: { a: 1 } },
      { level: 'error', message: 'bad' },
    ])
  })
})

describe('console redaction', () => {
  const fake = (prefix: string): string => `${prefix}${crypto.randomUUID().replaceAll('-', '')}`

  test('redactString masks provider keys and JWT-like strings', () => {
    const or = fake('sk-or-v1-')
    const sk = fake('sk-')
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2ln-_x'].join('.')
    const out = redactString(`a ${or} b ${sk} c ${jwt} d sk-short`)
    expect(out).toBe('a [redacted] b [redacted] c [redacted] d sk-short')
  })

  test('the console line is redacted (message and fields); the log file too', async () => {
    const dir = tmp()
    const key = fake('sk-')
    const spy = spyOn(globalThis.console, 'warn').mockImplementation(() => {})
    try {
      const log = createLogger({ level: 'info', dir, console: true })
      log.warn(`provider said Bearer abc123 and ${key}`, {
        detail: `keith_tok_${key}`,
        apiKey: 'x',
      })
      await log.flush()
      const printed = spy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(printed).not.toContain(key)
      expect(printed).not.toContain('abc123')
      expect(printed).toContain('[redacted]')
    } finally {
      spy.mockRestore()
    }
  })

  test('secretOnce prints raw on the console and never reaches the file', async () => {
    const dir = tmp()
    const token = fake('keith_')
    const spy = spyOn(globalThis.console, 'info').mockImplementation(() => {})
    try {
      const log = createLogger({ level: 'info', dir, console: true })
      log.secretOnce(`owner token: ${token}`)
      await log.flush()
      expect(spy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(token)
      expect(readdirSync(dir)).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('log hygiene (REQ-186, REQ-187)', () => {
  test('pin, passphrase, cookie and session fields are masked; error codes and ids stay', () => {
    expect(
      redact({
        pin: '1234',
        passphrase: 'correct horse',
        cookie: 'sid=abc',
        session: 'raw-session-value',
        code: 'ABCD-EFGH',
        sessionId: 'front:ana',
        guestSession: 'guest:01',
        ipHash: 'h1',
      }),
    ).toEqual({
      pin: '[redacted]',
      passphrase: '[redacted]',
      cookie: '[redacted]',
      session: '[redacted]',
      code: '[redacted]',
      sessionId: 'front:ana',
      guestSession: 'guest:01',
      ipHash: 'h1',
    })
    expect(redact({ code: 'W_HOOK_FAILED' })).toEqual({ code: 'W_HOOK_FAILED' })
    expect(redact({ code: 'GUEST_AUDIT' })).toEqual({ code: 'GUEST_AUDIT' })
    expect(redact({ code: 1 })).toEqual({ code: '[redacted]' })
  })

  test('the file keeps no pin, login code or cookie from a call site', async () => {
    const dir = tmp()
    const log = createLogger({
      level: 'info',
      dir,
      console: false,
      now: () => new Date(2026, 0, 5),
    })
    log.warn('login refused', { pin: '98765', code: 'QWER-TYUI', cookie: 'k=v' })
    await log.flush()
    const text = readFileSync(join(dir, 'keith-2026-01-05.log'), 'utf8')
    expect(text).not.toContain('98765')
    expect(text).not.toContain('QWER-TYUI')
    expect(text).not.toContain('k=v')
  })

  test('flush(timeoutMs) resolves at the cap even when a line is still queued', async () => {
    const log = createLogger({ level: 'info', dir: tmp(), console: false })
    log.info('queued')
    const started = Date.now()
    await log.flush(5_000)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test('no log line bypasses redact: core source writes to the console or a log file only through the logger', async () => {
    const root = join(import.meta.dir, '..')
    const offenders: string[] = []
    for await (const file of new Bun.Glob('**/*.ts').scan({ cwd: root, absolute: true })) {
      if (/\.test\.ts$|\/testing\//.test(file)) continue
      if (file.endsWith(join('platform', 'logger.ts'))) continue
      const text = await Bun.file(file).text()
      if (/\bconsole\.(log|info|warn|error|debug)\(/.test(text))
        offenders.push(relative(root, file))
      if (/appendFile\([^)]*\.log/.test(text)) offenders.push(relative(root, file))
    }
    expect(offenders).toEqual([])
  })
})

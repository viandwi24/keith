import { describe, expect, test } from 'bun:test'
import { createFakeClock } from '@keith/sdk/testing'
import { systemClock } from './clock.ts'
import { createLogger, REDACTED, redactSecrets } from './logger.ts'

function capture(level?: 'debug' | 'info' | 'warn' | 'error') {
  const lines: Record<string, unknown>[] = []
  const log = createLogger({
    level,
    clock: createFakeClock(42),
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  })
  return { log, lines }
}

describe('createLogger', () => {
  test('writes JSON lines with ts, level, msg and fields', () => {
    const { log, lines } = capture()
    log.info('turn completed', { steps: 2 })
    expect(lines).toEqual([{ ts: 42, level: 'info', msg: 'turn completed', steps: 2 }])
  })

  test('drops lines below the level', () => {
    const { log, lines } = capture('warn')
    log.debug('a')
    log.info('b')
    log.warn('c')
    log.error('d')
    expect(lines.map((l) => l.msg)).toEqual(['c', 'd'])
  })

  test('child loggers add fields', () => {
    const { log, lines } = capture()
    log.child({ pluginId: 'x' }).child({ step: 1 }).error('boom', { extra: true })
    expect(lines[0]).toMatchObject({ pluginId: 'x', step: 1, extra: true, level: 'error' })
  })

  test('redacts fields whose key looks secret, at any depth', () => {
    const { log, lines } = capture()
    log.info('config loaded', {
      apiKey: 'sk-1',
      nested: { authToken: 't', password: 'p', ok: 'yes', list: [{ clientSecret: 's' }] },
    })
    expect(lines[0]).toMatchObject({
      apiKey: REDACTED,
      nested: { authToken: REDACTED, password: REDACTED, ok: 'yes', list: [{ clientSecret: REDACTED }] },
    })
    expect(JSON.stringify(lines)).not.toContain('sk-1')
  })

  test('serializes errors and bigints', () => {
    expect(redactSecrets({ e: new Error('bad'), n: 10n })).toEqual({
      e: { name: 'Error', message: 'bad' },
      n: '10',
    })
  })

  test('writes each line to both write and file', () => {
    const out: string[] = []
    const file: string[] = []
    const log = createLogger({
      level: 'warn',
      clock: createFakeClock(1),
      write: (l) => out.push(l),
      file: { write: (l) => file.push(l) },
    })
    log.info('dropped')
    log.child({ password: 'p' }).error('kept')
    expect(out).toEqual(['{"ts":1,"level":"error","msg":"kept","password":"[redacted]"}'])
    expect(file).toEqual(out)
  })

  test('systemClock returns the current time', () => {
    const before = Date.now()
    expect(systemClock.now()).toBeGreaterThanOrEqual(before)
  })
})

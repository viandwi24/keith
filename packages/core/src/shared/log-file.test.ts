import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeClock } from '@keith/sdk/testing'
import { createLogFile, LOG_FILE_KEEP, LOG_FILE_MAX_BYTES, LOG_FILE_NAME } from './log-file.ts'
import { createLogger } from './logger.ts'

const dirs: string[] = []
function tempLogs(): string {
  const dir = mkdtempSync(join(tmpdir(), 'keith-logs-'))
  dirs.push(dir)
  return join(dir, 'logs')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const lines = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')

describe('createLogFile', () => {
  test('defaults: keith.log, 10 MiB, 5 files', () => {
    expect(LOG_FILE_NAME).toBe('keith.log')
    expect(LOG_FILE_MAX_BYTES).toBe(10 * 1024 * 1024)
    expect(LOG_FILE_KEEP).toBe(5)
  })

  test('creates the directory and gets the same JSON lines as stdout', () => {
    const dir = tempLogs()
    const file = createLogFile({ dir })
    const stdout: string[] = []
    const log = createLogger({ clock: createFakeClock(7), write: (l) => stdout.push(l), file })
    log.info('hello', { apiKey: 'sk-1' })
    log.warn('second')
    file.close()
    expect(file.path).toBe(join(dir, 'keith.log'))
    const written = lines(file.path)
    expect(written).toEqual(stdout)
    expect(written.map((l) => JSON.parse(l))).toEqual([
      { ts: 7, level: 'info', msg: 'hello', apiKey: '[redacted]' },
      { ts: 7, level: 'warn', msg: 'second' },
    ])
  })

  test('appends to an existing file and counts its size', () => {
    const dir = tempLogs()
    createLogFile({ dir }).close()
    writeFileSync(join(dir, 'keith.log'), `${'x'.repeat(9)}\n`)
    const file = createLogFile({ dir, maxBytes: 15 })
    file.write('abcd') // 10 + 5 = 15: fits
    file.write('e') // would be 17: rotates
    file.close()
    expect(lines(join(dir, 'keith.log.1'))).toEqual(['x'.repeat(9), 'abcd'])
    expect(lines(join(dir, 'keith.log'))).toEqual(['e'])
  })

  test('rotates at the size limit and keeps N files', () => {
    const dir = tempLogs()
    const file = createLogFile({ dir, maxBytes: 10, keep: 3 })
    for (let i = 0; i < 6; i++) file.write(`line-${i}`) // 7 bytes each: one line per file
    file.close()
    expect(readdirSync(dir).sort()).toEqual(['keith.log', 'keith.log.1', 'keith.log.2'])
    expect(lines(join(dir, 'keith.log'))).toEqual(['line-5'])
    expect(lines(join(dir, 'keith.log.1'))).toEqual(['line-4'])
    expect(lines(join(dir, 'keith.log.2'))).toEqual(['line-3'])
  })

  test('a line longer than the limit is written whole', () => {
    const dir = tempLogs()
    const file = createLogFile({ dir, maxBytes: 4, keep: 2 })
    file.write('0123456789')
    file.write('ab')
    file.close()
    expect(lines(join(dir, 'keith.log.1'))).toEqual(['0123456789'])
    expect(lines(join(dir, 'keith.log'))).toEqual(['ab'])
  })

  test('keep = 1 truncates instead of keeping old files', () => {
    const dir = tempLogs()
    const file = createLogFile({ dir, maxBytes: 5, keep: 1 })
    file.write('aaaa')
    file.write('bbbb')
    file.close()
    expect(readdirSync(dir)).toEqual(['keith.log'])
    expect(lines(join(dir, 'keith.log'))).toEqual(['bbbb'])
  })

  test('writes after close are dropped', () => {
    const dir = tempLogs()
    const file = createLogFile({ dir })
    file.close()
    file.close()
    file.write('late')
    expect(existsSync(file.path)).toBe(true)
    expect(lines(file.path)).toEqual([])
  })
})

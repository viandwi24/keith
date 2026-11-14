import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedProvider } from 'eharness/testing'
import { LOCK_FILE } from './modules/admin/index.ts'
import { loadConfig } from './platform/config.ts'
import { type FileLogger, silentLogger } from './platform/logger.ts'
import { type RunningCore, runCore, signalStop } from './run-core.ts'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const newDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** The lines of the one daily log file in `dir` (the child writes nothing else). */
const lines = (dir: string): Record<string, unknown>[] => {
  const file = readdirSync(dir).find((n) => n.startsWith('keith-')) ?? 'missing.log'
  return readFileSync(join(dir, file), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
}

// the crash child: a timer rejects (or throws) after the handlers are installed
const CHILD = `
import { createLogger } from ${JSON.stringify(join(import.meta.dir, 'platform/logger.ts'))}
import { installCrashHandlers } from ${JSON.stringify(join(import.meta.dir, 'run-core.ts'))}
const logger = createLogger({ level: 'info', dir: process.argv[2], console: false })
installCrashHandlers(logger)
const mode = process.argv[3]
setTimeout(() => {
  if (mode === 'throw') throw new Error('UNCAUGHT_BOOM')
  void Promise.reject(new Error('TIMER_BOOM'))
}, 10)
setTimeout(() => {}, 30_000)
`

describe('crash handlers (FD11-06)', () => {
  for (const [mode, label, text] of [
    ['reject', 'unhandled rejection', 'TIMER_BOOM'],
    ['throw', 'uncaught exception', 'UNCAUGHT_BOOM'],
  ] as const) {
    test(`a ${label} leaves its line on disk and the process exits 1`, async () => {
      const dir = newDir('keith-crash-')
      const script = join(dir, 'child.ts')
      const logs = join(dir, 'logs')
      writeFileSync(script, CHILD)
      const child = Bun.spawn([process.execPath, script, logs, mode], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const code = await child.exited
      expect(code).toBe(1)
      const found = lines(logs).find((l) => l.msg === `${label}: ${text}`)
      expect(found?.level).toBe('error')
    })
  }
})

describe('signalStop', () => {
  const fake = (stop: () => Promise<void>): RunningCore => ({ stop }) as unknown as RunningCore
  const recorder = (): { logger: FileLogger; errors: string[] } => {
    const errors: string[] = []
    const logger = { ...silentLogger, error: (m: string) => void errors.push(m) }
    return { logger: { ...logger, flush: async () => {}, secretOnce() {} } as FileLogger, errors }
  }

  test('a clean stop exits 0', async () => {
    const codes: number[] = []
    const { logger } = recorder()
    const stop = signalStop(
      fake(async () => {}),
      logger,
      { exit: (c) => codes.push(c) },
    )
    await stop('SIGTERM')
    expect(codes).toEqual([0])
  })

  test('a stop that throws is logged and exits 1', async () => {
    const codes: number[] = []
    const { logger, errors } = recorder()
    const stop = signalStop(
      fake(async () => {
        throw new Error('close failed')
      }),
      logger,
      { exit: (c) => codes.push(c) },
    )
    await stop('SIGINT')
    expect(codes).toEqual([1])
    expect(errors.join('\n')).toContain('stop failed: close failed')
  })

  test('a stop that hangs is forced out at the cap with exit 1', async () => {
    const codes: number[] = []
    const { logger } = recorder()
    const stop = signalStop(
      fake(() => new Promise<void>(() => {})),
      logger,
      {
        exit: (c) => codes.push(c),
        capMs: 20,
      },
    )
    void stop('SIGINT')
    await new Promise((r) => setTimeout(r, 120))
    expect(codes).toEqual([1])
  })

  test('a second signal while stopping does not run stop again and exits 1 at once', async () => {
    const codes: number[] = []
    let calls = 0
    const { logger } = recorder()
    const stop = signalStop(
      fake(() => {
        calls++
        return new Promise<void>(() => {})
      }),
      logger,
      { exit: (c) => codes.push(c), capMs: 60_000 },
    )
    void stop('SIGINT')
    await stop('SIGINT')
    expect(calls).toBe(1)
    expect(codes).toEqual([1])
  })
})

describe('runCore stop', () => {
  test('a stop that throws still releases core.lock', async () => {
    const dir = newDir('keith-stop-')
    const config = loadConfig({ KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'run-core' })
    const running = await runCore({
      config,
      logger: { ...silentLogger, flush: async () => {}, secretOnce() {} },
      core: {
        definitions: [scriptedProvider({ models: { a: [{ text: 'a' }], b: [{ text: 'b' }] } })],
        catalogs: { offline: true },
        localTrust: 'full',
      },
      port: 0,
    })
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true)
    running.core.close = async () => {
      throw new Error('close failed')
    }
    await expect(running.stop()).rejects.toThrow('close failed')
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false)
  })
})

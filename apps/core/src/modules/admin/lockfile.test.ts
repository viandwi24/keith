import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, LockHeldError } from './lockfile.ts'

const dir = mkdtempSync(join(tmpdir(), 'keith-lock-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const LOCKFILE = join(import.meta.dir, 'lockfile.ts')

describe('core.lock', () => {
  test('exclusive: a second take fails while the first is held, and works after release', () => {
    const path = join(dir, 'a.lock')
    const first = acquireLock(path)
    expect(readFileSync(path, 'utf8').trim()).toBe(String(process.pid))
    expect(() => acquireLock(path)).toThrow(LockHeldError)
    first.release()
    expect(existsSync(path)).toBe(false)
    acquireLock(path).release()
  })

  test('a lock of a dead pid is taken over', () => {
    const path = join(dir, 'b.lock')
    writeFileSync(path, '2147483646\n') // no such process
    const lock = acquireLock(path)
    expect(readFileSync(path, 'utf8').trim()).toBe(String(process.pid))
    lock.release()
    expect(existsSync(`${path}.takeover`)).toBe(false)
  })

  test('a takeover guard older than 10 s is removed and the stale lock is taken', () => {
    const path = join(dir, 'c.lock')
    writeFileSync(path, '2147483646\n')
    writeFileSync(`${path}.takeover`, '2147483645\n')
    const old = new Date(Date.now() - 11_000)
    utimesSync(`${path}.takeover`, old, old)
    const lock = acquireLock(path)
    expect(readFileSync(path, 'utf8').trim()).toBe(String(process.pid))
    expect(existsSync(`${path}.takeover`)).toBe(false)
    lock.release()
  })

  test('a live holder is refused even while a guard file exists', () => {
    const path = join(dir, 'd.lock')
    writeFileSync(path, `${process.pid}\n`)
    writeFileSync(`${path}.takeover`, '1\n')
    expect(() => acquireLock(path)).toThrow(LockHeldError)
    expect(existsSync(`${path}.takeover`)).toBe(true) // not ours: left alone
    rmSync(path)
    rmSync(`${path}.takeover`)
  })

  test('five processes race for one stale lock: exactly one wins', async () => {
    const path = join(dir, 'race.lock')
    writeFileSync(path, '2147483646\n')
    // each child takes the lock, reports it and keeps it for 3 s, so the others meet a live pid
    const child = join(dir, 'race-child.ts')
    writeFileSync(
      child,
      `import { acquireLock, LockHeldError } from ${JSON.stringify(LOCKFILE)}
try { acquireLock(${JSON.stringify(path)}); console.log('won'); Bun.sleepSync(3000) }
catch (error) { console.log(error instanceof LockHeldError ? 'held' : 'error ' + String(error)) }
`,
    )
    const runs = Array.from({ length: 5 }, () =>
      Bun.spawn([process.execPath, child], { stdout: 'pipe', stderr: 'pipe' }),
    )
    const outputs = await Promise.all(
      runs.map(async (p) => (await new Response(p.stdout).text()).trim()),
    )
    await Promise.all(runs.map((p) => p.exited))
    expect(outputs.filter((o) => o === 'won')).toHaveLength(1)
    expect(outputs.filter((o) => o === 'held')).toHaveLength(4)
    expect(existsSync(`${path}.takeover`)).toBe(false)
  }, 30_000)
})

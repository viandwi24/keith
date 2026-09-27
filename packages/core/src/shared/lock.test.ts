import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isKeithError } from '@keith/sdk'
import { createFakeClock } from '@keith/sdk/testing'
import { acquireHomeLock, isProcessAlive, LOCK_FILE_NAME, withHomeLock } from './lock.ts'

const homes: string[] = []
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'keith-lock-'))
  homes.push(home)
  return home
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

describe('acquireHomeLock', () => {
  test('writes keith.lock with pid and start time', async () => {
    const home = tempHome()
    const lock = await acquireHomeLock(home, {
      pid: 4242,
      clock: createFakeClock(1000),
      isAlive: () => true,
    })
    expect(lock.path).toBe(join(home, LOCK_FILE_NAME))
    const info = JSON.parse(readFileSync(lock.path, 'utf8'))
    expect(info).toMatchObject({ pid: 4242, startedAt: 1000 })
    expect(readdirSync(home)).toEqual([LOCK_FILE_NAME])
    await lock.release()
  })

  test('a second acquire fails with a KeithError naming the pid', async () => {
    const home = tempHome()
    const lock = await acquireHomeLock(home)
    const second = await acquireHomeLock(home).catch((e: unknown) => e)
    expect(isKeithError(second)).toBe(true)
    expect((second as Error).message).toContain(`pid ${process.pid}`)
    expect((second as Error).message).toContain(lock.path)
    // The failed attempt leaves the holder's file untouched and no temp file behind.
    expect(readdirSync(home)).toEqual([LOCK_FILE_NAME])
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).token).toBe(lock.info.token)
    await lock.release()
  })

  test('release frees the lock and is idempotent', async () => {
    const home = tempHome()
    const lock = await acquireHomeLock(home)
    await lock.release()
    await lock.release()
    expect(existsSync(lock.path)).toBe(false)
    const again = await acquireHomeLock(home)
    await again.release()
  })

  test('a stale lock (pid not alive) is taken over', async () => {
    const home = tempHome()
    writeFileSync(join(home, LOCK_FILE_NAME), JSON.stringify({ pid: 999_999, startedAt: 1, token: 'old' }))
    const lock = await acquireHomeLock(home, { isAlive: (pid) => pid !== 999_999 })
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).pid).toBe(process.pid)
    await lock.release()
  })

  test('an unreadable lock file is stale', async () => {
    const home = tempHome()
    writeFileSync(join(home, LOCK_FILE_NAME), 'garbage')
    const lock = await acquireHomeLock(home)
    expect(lock.info.pid).toBe(process.pid)
    await lock.release()
  })

  test('release does not remove a lock taken over by someone else', async () => {
    const home = tempHome()
    const first = await acquireHomeLock(home, { pid: 1, isAlive: () => false })
    const second = await acquireHomeLock(home, { isAlive: () => false })
    await first.release()
    expect(JSON.parse(readFileSync(second.path, 'utf8')).token).toBe(second.info.token)
    await second.release()
  })

  test('creates a missing home', async () => {
    const home = join(tempHome(), 'nested')
    const lock = await acquireHomeLock(home)
    expect(existsSync(lock.path)).toBe(true)
    await lock.release()
  })

  test('withHomeLock releases after fn, also on error', async () => {
    const home = tempHome()
    await expect(
      withHomeLock(home, async () => {
        expect(existsSync(join(home, LOCK_FILE_NAME))).toBe(true)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(join(home, LOCK_FILE_NAME))).toBe(false)
  })
})

describe('isProcessAlive', () => {
  test('this process is alive, nonsense pids are not', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-5)).toBe(false)
  })
})

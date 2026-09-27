// The single-instance lock on KEITH_HOME (I-1 "exactly one Mind", hardening D1).

import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KeithError } from '@keith/sdk'
import { systemClock } from './clock.ts'
import type { Clock } from './types.ts'

/** The lock file's name inside KEITH_HOME. */
export const LOCK_FILE_NAME = 'keith.lock'

/** What the lock file holds (JSON). */
export type LockInfo = {
  pid: number
  /** Epoch ms when the lock was taken. */
  startedAt: number
  /** Distinguishes two holders that share a pid (tests, or a pid reused after a crash). */
  token: string
}

export type HomeLock = {
  readonly path: string
  readonly info: LockInfo
  /** Removes the lock file if it is still ours. Safe to call twice. */
  release(): Promise<void>
}

export type AcquireHomeLockOptions = {
  /** Default: this process. */
  pid?: number | undefined
  clock?: Clock | undefined
  /** Default: `process.kill(pid, 0)`. Tests inject a fake. */
  isAlive?: ((pid: number) => boolean) | undefined
}

/** True when a process with this pid exists (EPERM means it exists but isn't ours). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function parseLock(text: string): LockInfo | null {
  try {
    const value = JSON.parse(text) as Partial<LockInfo>
    if (typeof value.pid !== 'number' || typeof value.startedAt !== 'number') return null
    return { pid: value.pid, startedAt: value.startedAt, token: String(value.token ?? '') }
  } catch {
    return null
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * Takes the exclusive lock `<home>/keith.lock` (creates `home` if needed). The file is written
 * under a temporary name and hard-linked into place, so it appears atomically with its content.
 * A lock whose pid is not alive (or whose file is unreadable) is stale and taken over. A live
 * holder is a `KeithError` naming its pid.
 */
export async function acquireHomeLock(home: string, opts: AcquireHomeLockOptions = {}): Promise<HomeLock> {
  const path = join(home, LOCK_FILE_NAME)
  const isAlive = opts.isAlive ?? isProcessAlive
  const info: LockInfo = {
    pid: opts.pid ?? process.pid,
    startedAt: (opts.clock ?? systemClock).now(),
    token: randomUUID(),
  }
  const text = JSON.stringify(info)
  await mkdir(home, { recursive: true })
  const tmp = `${path}.${info.token}.tmp`
  await writeFile(tmp, text)
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(tmp, path)
        return makeLock(path, info, text)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const current = await readText(path)
      if (current === null) continue
      const holder = parseLock(current)
      if (holder !== null && isAlive(holder.pid)) {
        throw new KeithError(
          'INTERNAL',
          `Keith is already running with this home (pid ${holder.pid}, since ${new Date(holder.startedAt).toISOString()}). Stop it first. Lock file: ${path}`,
          { details: { pid: holder.pid, startedAt: holder.startedAt, lockFile: path } },
        )
      }
      // Stale. Remove it only if nobody replaced it since we read it.
      if ((await readText(path)) === current) await unlinkIfExists(path)
    }
    throw new KeithError('INTERNAL', `could not take the lock ${path}`, { details: { lockFile: path } })
  } finally {
    await unlinkIfExists(tmp)
  }
}

function makeLock(path: string, info: LockInfo, text: string): HomeLock {
  let released = false
  return {
    path,
    info,
    async release() {
      if (released) return
      released = true
      if ((await readText(path)) === text) await unlinkIfExists(path)
    },
  }
}

/** Runs `fn` while holding the home lock, then releases it. */
export async function withHomeLock<T>(
  home: string,
  fn: () => Promise<T>,
  opts?: AcquireHomeLockOptions,
): Promise<T> {
  const lock = await acquireHomeLock(home, opts)
  try {
    return await fn()
  } finally {
    await lock.release()
  }
}

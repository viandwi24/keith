import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'

export class LockHeldError extends Error {
  constructor(
    readonly path: string,
    readonly pid: number,
  ) {
    super(`another keith-core process (pid ${pid}) holds ${path}`)
    this.name = 'LockHeldError'
  }
}

export interface FileLock {
  release(): void
}

/** A takeover guard older than this belongs to a process that died inside the takeover: it is removed. */
const GUARD_STALE_MS = 10_000
/** How long a process waits for a live takeover guard before it starts again from the top. */
const GUARD_WAIT_MS = 2_000
const WAIT_STEP_MS = 20
/** Passes over the lock before giving up (each pass may wait for a guard). */
const ATTEMPTS = 3

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but is not ours
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Create `path` with our pid, exclusively. False when it already exists. */
function createExclusive(path: string): boolean {
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/** The pid in the lock, or undefined when the file vanished between the calls. */
function readPid(path: string): number | undefined {
  try {
    return Number.parseInt(readFileSync(path, 'utf8'), 10)
  } catch {
    return undefined
  }
}

function guardAge(guard: string): number {
  try {
    return Date.now() - statSync(guard).mtimeMs
  } catch {
    return 0
  }
}

/** Another process holds the takeover guard: wait for it to finish (or go stale), up to `GUARD_WAIT_MS`. */
function waitForGuard(guard: string): void {
  const until = Date.now() + GUARD_WAIT_MS
  while (existsSync(guard)) {
    if (guardAge(guard) > GUARD_STALE_MS) {
      rmSync(guard, { force: true })
      return
    }
    if (Date.now() >= until) return
    Bun.sleepSync(WAIT_STEP_MS)
  }
}

type Takeover = { kind: 'taken' } | { kind: 'retry' } | { kind: 'held'; pid: number }

/**
 * Take over a stale lock under `<path>.takeover` (created exclusively). Under the guard the holder
 * re-reads the pid (still stale?), removes the lock and creates its own with `wx`. Two processes
 * that found the same stale lock therefore never both take it.
 */
function takeOver(path: string): Takeover {
  const guard = `${path}.takeover`
  if (!createExclusive(guard)) {
    waitForGuard(guard)
    return { kind: 'retry' }
  }
  try {
    const pid = readPid(path)
    if (pid === undefined) return createExclusive(path) ? { kind: 'taken' } : { kind: 'retry' }
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) return { kind: 'held', pid }
    rmSync(path, { force: true }) // still stale
    return createExclusive(path) ? { kind: 'taken' } : { kind: 'retry' }
  } finally {
    rmSync(guard, { force: true })
  }
}

function lockHandle(path: string): FileLock {
  let released = false
  return {
    release() {
      if (released) return
      released = true
      // only remove our own lock
      try {
        if (Number.parseInt(readFileSync(path, 'utf8'), 10) === process.pid) rmSync(path)
      } catch {
        // already gone
      }
    },
  }
}

/**
 * Take `<dataDir>/core.lock`: created exclusively with our pid. A lock whose pid is not alive
 * is stale and is taken over under a guard (`core.lock.takeover`, see `takeOver`); a live one
 * throws `LockHeldError`.
 */
export function acquireLock(path: string): FileLock {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (createExclusive(path)) return lockHandle(path)
    const pid = readPid(path)
    if (pid === undefined) continue // vanished between the two calls: try again
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new LockHeldError(path, pid)
    const result = takeOver(path)
    if (result.kind === 'taken') return lockHandle(path)
    if (result.kind === 'held') throw new LockHeldError(path, result.pid)
  }
  throw new Error(`could not take ${path}`)
}

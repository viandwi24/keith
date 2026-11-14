import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyDataFolder, trackTempDir } from './data-copy.ts'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'keith-eval-copy-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const put = (path: string, text = 'x'): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

describe('copyDataFolder (--data)', () => {
  test('the copy is a consistent database even while a WAL writer holds rows not yet checkpointed', () => {
    const source = tmp()
    const writer = new Database(join(source, 'keith.db'))
    writer.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE notes (v TEXT); INSERT INTO notes VALUES ('a'), ('b'), ('c');",
    )
    expect(existsSync(join(source, 'keith.db-wal'))).toBe(true)
    const target = join(tmp(), 'run')
    copyDataFolder(source, target)
    writer.close()

    expect(existsSync(join(target, 'keith.db-wal'))).toBe(false)
    expect(existsSync(join(target, 'keith.db-shm'))).toBe(false)
    const copy = new Database(join(target, 'keith.db'), { readonly: true })
    try {
      expect(copy.query<{ n: number }, []>('SELECT count(*) AS n FROM notes').get()?.n).toBe(3)
    } finally {
      copy.close()
    }
  })

  test('takes the key, the workspace and the memory only, never a socket, lock, backup, export or log', () => {
    const source = tmp()
    put(join(source, 'secret.key'), 'key')
    put(join(source, 'workspace', 'people', 'p1', 'run.sh'))
    put(join(source, 'memory', 'p1', 'note.md'))
    put(join(source, 'core.sock'))
    put(join(source, 'core.lock'), '123')
    put(join(source, 'backups', 'keith-20260101-000000.db'))
    put(join(source, 'exports', 'alice.tar'))
    put(join(source, 'logs', 'keith-2026-01-01.log'))
    symlinkSync('/etc/hosts', join(source, 'workspace', 'people', 'p1', 'hosts-link'))

    const target = join(tmp(), 'run')
    copyDataFolder(source, target)

    expect(existsSync(join(target, 'secret.key'))).toBe(true)
    expect(existsSync(join(target, 'workspace', 'people', 'p1', 'run.sh'))).toBe(true)
    expect(existsSync(join(target, 'memory', 'p1', 'note.md'))).toBe(true)
    for (const name of ['core.sock', 'core.lock', 'backups', 'exports', 'logs']) {
      expect(existsSync(join(target, name))).toBe(false)
    }
    // a symbolic link is neither followed nor copied
    expect(existsSync(join(target, 'workspace', 'people', 'p1', 'hosts-link'))).toBe(false)
    expect(lstatSync(join(target, 'secret.key')).isSymbolicLink()).toBe(false)
  })

  test('the target folder and the database copy are owner-only', () => {
    const source = tmp()
    new Database(join(source, 'keith.db')).close()
    const target = join(tmp(), 'run')
    copyDataFolder(source, target)
    expect(lstatSync(target).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(target, 'keith.db')).mode & 0o077).toBe(0)
  })
})

describe('trackTempDir', () => {
  test('the returned function removes the folder and its exit hooks', () => {
    const dir = join(tmp(), 'work')
    mkdirSync(dir)
    const untrack = trackTempDir(dir, () => {})
    untrack()
    expect(existsSync(dir)).toBe(false)
  })

  test('a SIGINT during a run removes the folder and exits 130; SIGTERM 143', async () => {
    const module = join(import.meta.dir, 'data-copy.ts')
    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const) {
      const script = `(async () => {
        const { mkdtempSync } = await import('node:fs')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const { trackTempDir } = await import(${JSON.stringify(module)})
        const dir = mkdtempSync(join(tmpdir(), 'keith-eval-signal-'))
        trackTempDir(dir)
        console.log(dir)
        setInterval(() => {}, 1000)
      })()`
      const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let text = ''
      while (!text.includes('\n')) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value)
      }
      reader.releaseLock()
      const dir = text.split('\n')[0] ?? ''
      expect(existsSync(dir)).toBe(true)
      child.kill(signal)
      expect(await child.exited).toBe(code)
      expect(existsSync(dir)).toBe(false)
    }
  })
})

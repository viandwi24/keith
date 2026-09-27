// A size-rotating JSON-lines log file (hardening D2): `logs/keith.log`, then keith.log.1 … .N-1.

import { closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/** The current log file's name inside `logs/`. */
export const LOG_FILE_NAME = 'keith.log'
/** Rotate when the current file would grow past this many bytes. */
export const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024
/** Files kept in total: the current one plus `LOG_FILE_KEEP - 1` rotated ones. */
export const LOG_FILE_KEEP = 5

export type LogFileOptions = {
  /** The `logs/` directory. Created if missing. */
  dir: string
  fileName?: string | undefined
  maxBytes?: number | undefined
  /** At least 1. */
  keep?: number | undefined
}

export type LogFile = {
  readonly path: string
  /** Appends one line (a newline is added). Synchronous, so no line is lost on exit. */
  write(line: string): void
  close(): void
}

/**
 * Opens (appending) a rotating log file. When a line would push the file past `maxBytes`, the
 * file becomes `<name>.1`, older ones shift up, and the one past `keep` is deleted. A single
 * line longer than `maxBytes` is still written whole, to a fresh file.
 */
export function createLogFile(opts: LogFileOptions): LogFile {
  const name = opts.fileName ?? LOG_FILE_NAME
  const maxBytes = opts.maxBytes ?? LOG_FILE_MAX_BYTES
  const keep = Math.max(1, Math.floor(opts.keep ?? LOG_FILE_KEEP))
  const path = join(opts.dir, name)
  mkdirSync(opts.dir, { recursive: true })

  let fd: number | null = openSync(path, 'a')
  let size = fstatSync(fd).size

  const rotate = (): void => {
    if (fd !== null) closeSync(fd)
    rmSync(`${path}.${keep - 1}`, { force: true })
    for (let i = keep - 2; i >= 1; i--) {
      try {
        renameSync(`${path}.${i}`, `${path}.${i + 1}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (keep > 1) renameSync(path, `${path}.1`)
    else rmSync(path, { force: true })
    fd = openSync(path, 'a')
    size = 0
  }

  return {
    path,
    write(line) {
      if (fd === null) return
      const bytes = Buffer.from(`${line}\n`, 'utf8')
      if (size > 0 && size + bytes.length > maxBytes) rotate()
      writeSync(fd as number, bytes)
      size += bytes.length
    },
    close() {
      if (fd === null) return
      closeSync(fd)
      fd = null
    },
  }
}

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A Unix socket path holds ~104 bytes on macOS: stay under it with a margin (same as core). */
const SOCKET_PATH_LIMIT = 100

/** File in the core data dir that records the socket path while core runs and uses the fallback. */
const SOCKET_PATH_FILE = 'core.sock.path'

/**
 * Where core's local socket is for a data dir: the path core recorded in `<dataDir>/core.sock.path`,
 * else `<dataDir>/core.sock`, else (that path is too long) `$TMPDIR/keith-<hash of the data dir>.sock`.
 * The same rule as `socketPathFor` in apps/core, which a client cannot import.
 */
export function localSocketPath(dataDir: string, tmp: string = tmpdir()): string {
  const recorded = join(dataDir, SOCKET_PATH_FILE)
  if (existsSync(recorded)) {
    const path = readFileSync(recorded, 'utf8').trim()
    if (path !== '') return path
  }
  const direct = join(dataDir, 'core.sock')
  if (Buffer.byteLength(direct) <= SOCKET_PATH_LIMIT) return direct
  const short = createHash('sha256').update(dataDir).digest('hex').slice(0, 12)
  return join(tmp, `keith-${short}.sock`)
}

/** Whether something answers HTTP on the socket (any response counts). */
export async function probeSocket(path: string, timeoutMs = 800): Promise<boolean> {
  if (!existsSync(path)) return false
  try {
    await fetch('http://localhost/health', {
      unix: path,
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit)
    return true
  } catch {
    return false
  }
}

/** A `fetch` that talks to the core through its Unix socket (no token needed there). */
export function socketFetch(path: string): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetch(input, { ...init, unix: path } as RequestInit)) as typeof fetch
}

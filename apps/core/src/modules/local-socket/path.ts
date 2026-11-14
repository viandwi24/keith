import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `sockaddr_un` holds ~104 bytes on macOS (108 on Linux): stay under it with a margin. */
export const SOCKET_PATH_LIMIT = 100

/** File in the data folder that records the socket path when it is not `<dataDir>/core.sock`. */
export const SOCKET_PATH_FILE = 'core.sock.path'

/**
 * The path of core's local socket: `<dataDir>/core.sock`, or, when that is too long for a Unix
 * socket, `$TMPDIR/keith-<hash of the data dir>.sock`. A pure function of the data dir, so the
 * server and every CLI compute the same path (the server also records it in `core.sock.path`).
 */
export function socketPathFor(dataDir: string, tmp: string = tmpdir()): string {
  const direct = join(dataDir, 'core.sock')
  if (Buffer.byteLength(direct) <= SOCKET_PATH_LIMIT) return direct
  const short = createHash('sha256').update(dataDir).digest('hex').slice(0, 12)
  return join(tmp, `keith-${short}.sock`)
}

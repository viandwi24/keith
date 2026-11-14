// The workspace folder of a room (ADR-0021 §1, docs/specs/corpus-callosum.md "ACL"): `<dataDir>/workspace/rooms/<roomId>/`,
// created with the room and made read-only when it ends. The folder is kept after the end (deleting it is a later decision).
import { chmodSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { workspaceDir } from '../../platform/workspace-paths.ts'

/** A room id is a UUID (`RoomIdSchema`); anything else names no folder. */
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Modes of a sealed folder: readable and listable, never writable. */
const SEALED_DIR_MODE = 0o555
const SEALED_FILE_MODE = 0o444

/** The room folder: `<dataDir>/workspace/rooms/<roomId>`. Throws for an id that cannot name a folder. */
export function roomWorkspaceDir(dataDir: string, roomId: string): string {
  if (!ROOM_ID.test(roomId)) throw new RangeError(`${roomId} cannot name a room folder`)
  return join(workspaceDir(dataDir), 'rooms', roomId)
}

/** Creates the room folder (idempotent). Returns its path. */
export function createRoomWorkspace(dataDir: string, roomId: string): string {
  const dir = roomWorkspaceDir(dataDir, roomId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Makes the room folder read-only, recursively: directories `0555`, files `0444`. Idempotent; a folder that does not exist
 * is left alone. The room service calls it when the room ends.
 */
export function sealRoomWorkspace(dataDir: string, roomId: string): void {
  const dir = roomWorkspaceDir(dataDir, roomId)
  if (!isDirectory(dir)) return
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) chmodSync(child, SEALED_FILE_MODE)
    }
    chmodSync(path, SEALED_DIR_MODE)
  }
  walk(dir)
}

/** Whether the room folder exists and holds no write bit (the test of a sealed room). */
export function isRoomWorkspaceSealed(dataDir: string, roomId: string): boolean {
  const dir = roomWorkspaceDir(dataDir, roomId)
  if (!isDirectory(dir)) return false
  const mode = statSync(dir).mode & 0o777
  return (mode & 0o222) === 0
}

/** One entry of a room folder listing: the path is relative to the room folder, `/`-separated. */
export interface RoomFileEntry {
  name: string
  path: string
  dir: boolean
  size: number
}

/**
 * The entries of a folder inside `rooms/<roomId>/` (`path` relative, `''` for the room folder itself), directories first, then by
 * name. A missing room folder lists as empty at the top and as `undefined` below it; a path that leaves the room folder is
 * `undefined` too. Symbolic links are listed as links (their size is the link's own), never followed.
 */
export function listRoomFiles(
  dataDir: string,
  roomId: string,
  path = '',
): RoomFileEntry[] | undefined {
  const root = roomWorkspaceDir(dataDir, roomId)
  const dir = resolve(root, path)
  if (dir !== root && !dir.startsWith(root + sep)) return undefined
  if (!isDirectory(dir)) return path === '' ? [] : undefined
  return readdirSync(dir)
    .map((name): RoomFileEntry => {
      const full = join(dir, name)
      const info = lstatSync(full)
      return {
        name,
        path: relative(root, full).split(sep).join('/'),
        dir: info.isDirectory(),
        size: info.isDirectory() ? 0 : info.size,
      }
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

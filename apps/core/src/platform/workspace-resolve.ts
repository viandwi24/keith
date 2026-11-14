// Resolves a workspace path for one person (ADR-0021 §2, docs/specs/cortex.md "Workspace references"). Pure plumbing: the
// cortex workers, the motor (`sandbox.run` files) and the document tools all use it, so it lives in platform/, not in a feature.
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { workspaceDir } from './workspace-paths.ts'

/** Ids that may name a folder: `owner`, UUIDs, anything without a separator. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

/** Who asks for a workspace file: the person of the run, and the room membership check (injected: cortex has no rooms port). */
export interface WorkspaceCaller {
  readonly dataDir: string
  readonly person: string
  readonly isRoomMember?: (roomId: string, person: string) => boolean
}

/** A file the caller may use: its real path on disk and its logical path under the workspace root. */
export interface WorkspaceFile {
  readonly real: string
  /** `people/<id>/…` or `rooms/<id>/…`: the path as the audit names it. */
  readonly path: string
}

export type WorkspaceResolution =
  | { readonly ok: true; readonly file: WorkspaceFile }
  | { readonly ok: false; readonly code: 'path-refused'; readonly message: string }

const refuse = (message: string): WorkspaceResolution => ({
  ok: false,
  code: 'path-refused',
  message,
})

/** The real path of `path` when it exists, else the path itself. */
const realOrSelf = (path: string): string => (existsSync(path) ? realpathSync(path) : path)

/**
 * Walks `parts` from the real root, following each symlink and checking its target. A missing part is
 * taken as it is (a file that is about to be written). Undefined when a link is dangling or unreadable.
 */
function walk(root: string, parts: readonly string[]): string | undefined {
  let real = root
  for (const part of parts) {
    const next = join(real, part)
    let link: boolean
    try {
      link = lstatSync(next).isSymbolicLink()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        real = next
        continue
      }
      return undefined
    }
    if (!link) {
      real = next
      continue
    }
    try {
      real = realpathSync(next)
    } catch {
      return undefined
    }
  }
  return real
}

/**
 * Resolves a workspace path for `caller` (ADR-0021 §2, docs/specs/cortex.md "Workspace references"). A bare relative path
 * names a file of the caller's own folder; `people/<id>/…` only for the caller's own id; `rooms/<id>/…` only for a room
 * the caller is a member of; `keith/` never. `..`, absolute paths, NUL and backslashes are refused, and every symlink on
 * the way must stay inside the folder the path names. The file need not exist (an output is written to a new name).
 */
export function resolveWorkspacePath(caller: WorkspaceCaller, path: string): WorkspaceResolution {
  if (!SAFE_ID.test(caller.person)) return refuse('the caller has no workspace')
  if (typeof path !== 'string' || path.length === 0 || /[\0\\]/.test(path)) {
    return refuse(`"${String(path)}" is not a workspace path`)
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return refuse('absolute paths are refused')
  const parts = path.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.includes('..')) return refuse('".." is refused')
  const [head, id] = parts
  if (head === 'keith') return refuse('keith/ is not a person folder')
  let base: string[]
  if (head === 'people') {
    if (id === undefined) return refuse('name a file under people/<id>/')
    if (id !== caller.person) return refuse("another person's folder is refused")
    base = ['people', id]
  } else if (head === 'rooms') {
    if (id === undefined || !SAFE_ID.test(id)) return refuse('name a file under rooms/<id>/')
    if (caller.isRoomMember?.(id, caller.person) !== true) {
      return refuse('you are not a member of that room')
    }
    base = ['rooms', id]
  } else {
    base = ['people', caller.person]
  }
  const rest = head === 'people' || head === 'rooms' ? parts.slice(2) : parts
  if (rest.length === 0) return refuse('name a file, not a folder')

  const rootReal = realOrSelf(workspaceDir(caller.dataDir))
  const expected = join(rootReal, ...base)
  const real = walk(rootReal, [...base, ...rest])
  if (real === undefined || !real.startsWith(`${expected}${sep}`)) {
    return refuse('the path leaves the folder it names')
  }
  return { ok: true, file: { real, path: [...base, ...rest].join('/') } }
}

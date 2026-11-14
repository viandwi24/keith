import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessContext } from 'eharness'
import { personWorkspaceDir, workspaceDir } from '../../platform/workspace-paths.ts'
import { SAFE_ID } from '../../platform/workspace-resolve.ts'

/** Top-level entries of the workspace that belong to the layout (ADR-0021), never to the old shared folder. */
const LAYOUT = new Set(['people', 'rooms', 'keith'])

export {
  resolveWorkspacePath,
  type WorkspaceCaller,
  type WorkspaceFile,
  type WorkspaceResolution,
} from '../../platform/workspace-resolve.ts'
export { personWorkspaceDir, workspaceDir }

/**
 * The folder a worker of this run may use: the workspace of the principal it runs for, created on
 * first use. A run of no person, or an id that cannot name a folder, gets `undefined` (no workspace).
 */
export function workspaceOf(dataDir: string, ctx: HarnessContext): string | undefined {
  const person = ctx.principal?.id
  if (person === undefined || !SAFE_ID.test(person)) return undefined
  const dir = personWorkspaceDir(dataDir, person)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * One-time move of the old shared workspace: every entry of `<dataDir>/workspace` that is not part
 * of the layout goes to `workspace/keith/legacy-shared/`. Nothing is deleted; a second run finds
 * nothing to move. Returns the names moved.
 */
export function migrateLegacyWorkspace(dataDir: string): string[] {
  const root = workspaceDir(dataDir)
  mkdirSync(root, { recursive: true })
  const legacy = readdirSync(root).filter((name) => !LAYOUT.has(name))
  if (legacy.length === 0) return []
  const target = join(root, 'keith', 'legacy-shared')
  mkdirSync(target, { recursive: true })
  for (const name of legacy) {
    let to = join(target, name)
    for (let i = 1; existsSync(to); i++) to = join(target, `${name}.${i}`)
    renameSync(join(root, name), to)
  }
  return legacy
}

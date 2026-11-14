import { join } from 'node:path'

/** The root of all workspaces: `<dataDir>/workspace` (ADR-0021). Pure paths, so any module may import them. */
export function workspaceDir(dataDir: string): string {
  return join(dataDir, 'workspace')
}

/** One person's workspace folder: `<dataDir>/workspace/people/<personId>`. */
export function personWorkspaceDir(dataDir: string, personId: string): string {
  return join(workspaceDir(dataDir), 'people', personId)
}

// The workspace wiring (docs/specs/workspace.md): one service per core for the RPC router and Keith's `workspace` tool, the tool
// itself and the "On screen now" line of the front agent's reminder. A change is announced on the person's own front session.

import { WEB_WINDOW_POINT, WORKSPACE_CHANGED } from '@keith/contracts'
import { type Sqlite, workspacesRepo } from '@keith/db'
import type { HarnessPlugin } from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import type { AclActors } from './modules/acl/index.ts'
import type { Audit } from './modules/audit/index.ts'
import { emit } from './modules/brain-events/index.ts'
import {
  type CatalogApp,
  type ContributionLike,
  catalogOf,
  createWorkspaceService,
  onScreenLine,
  type ParietalService,
  type WorkspaceService,
  workspaceTool,
} from './modules/parietal/index.ts'
import type { Logger } from './platform/logger.ts'
import { type FrontGenerationOf, frontSessionId } from './platform/sessions.ts'
import type { UndoLog } from './platform/undo-log.ts'

export interface WorkspaceWiringDeps {
  sqlite: Sqlite
  store: ActivityStore
  generations: FrontGenerationOf
  parietal: ParietalService
  actors: AclActors
  audit: Pick<Audit, 'record'>
  undo: UndoLog
  logger: Pick<Logger, 'warn'>
  /** The contributions to an extension point (`PluginHost.contributions`); `web.window` holds the window apps (ADR-0038). */
  contributions?: (point: string) => readonly ContributionLike[]
  /** Whether a person holds a capability (an app's `permission`). */
  can?: (personId: string, capability: string) => Promise<boolean>
}

export interface WorkspaceWiring {
  service: WorkspaceService
  /** The front agent's `workspace` tool. */
  tool: HarnessPlugin
  /** The "On screen now" line of the person (undefined when no screen draws a workspace). */
  onScreen: (personId: string) => string | undefined
  /** The window apps of this core (the plugin `web` off: the built-in apps). */
  catalog: () => readonly CatalogApp[]
}

export function wireWorkspace(deps: WorkspaceWiringDeps): WorkspaceWiring {
  const warn = (message: string) => deps.logger.warn(message)
  // read on each call: the plugin host settles at boot, and the list is small
  const catalog = (): readonly CatalogApp[] =>
    catalogOf(deps.contributions?.(WEB_WINDOW_POINT) ?? [])
  const service = createWorkspaceService({
    repo: workspacesRepo(deps.sqlite),
    announce: (personId, record) =>
      emit(
        deps.store,
        WORKSPACE_CHANGED,
        frontSessionId(personId, deps.generations.current(personId)),
        null,
        record,
        warn,
      ),
    warn,
    catalog,
  })
  return {
    service,
    catalog,
    tool: workspaceTool({
      workspace: service,
      parietal: deps.parietal,
      actors: deps.actors,
      audit: deps.audit,
      undo: deps.undo,
      catalog,
      ...(deps.can === undefined ? {} : { can: deps.can }),
      event: (ctx, payload) =>
        emit(
          deps.store,
          'brain.parietal.workspace',
          ctx.session.id,
          null,
          { region: 'parietal', ...payload },
          warn,
        ),
    }),
    onScreen: (personId) =>
      onScreenLine(
        deps.parietal.list(personId),
        service.get(personId),
        deps.parietal.presence(personId).activeClient,
      ),
  }
}

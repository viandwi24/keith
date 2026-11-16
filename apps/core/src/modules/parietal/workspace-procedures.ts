// The `workspace` procedures (docs/specs/workspace.md, "RPC"): the signed-in person reads and changes their own workspace only.
import { rpc } from '../../platform/rpc.ts'
import { type CatalogApp, openableBy, webAppOf } from './web-apps.ts'
import type { WorkspaceService } from './workspace.ts'

export function workspaceProcedures(
  service: WorkspaceService,
  catalog: () => readonly CatalogApp[] = () => [],
) {
  return {
    get: rpc.workspace.get.handler(({ context }) => service.get(context.principal.personId)),
    apply: rpc.workspace.apply.handler(({ input, context }) =>
      service.apply(context.principal.personId, input, 'person'),
    ),
    undoKeith: rpc.workspace.undoKeith.handler(({ context }) =>
      service.undoKeith(context.principal.personId),
    ),
    // the window apps this person may open (ADR-0038 §4): an app's `permission` is checked against the caller's capabilities
    apps: rpc.workspace.apps.handler(({ context }) =>
      openableBy(catalog(), (c) => context.capabilities.has(c)).map(webAppOf),
    ),
  }
}

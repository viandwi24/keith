// The dreaming RPC area `dream` (docs/specs/dreaming.md "RPC", ADR-0031 §5, ADR-0020 §4). `status`, `mode`, `now`, `apply`, `undo`
// and `diary` act for the caller's own memory: the caller is the principal, and no argument names another person except `diary`
// (`personId`). The owner reads a member's diary only through the audited owner path (`acl.owner-access`); a member asking for
// anyone else's diary gets NOT_FOUND. A mode change re-syncs the person's `dream` built-in (the service's `onModeChanged`). The
// member default and the run cap are the owner's settings (`settings`, `settings.manage` with a step-up for a remote caller).

import type {
  DreamDiaryOutput,
  DreamingSettings,
  DreamingSettingsSet,
  DreamRunView,
  DreamStatusView,
} from '@keith/contracts'
import { ORPCError } from '@orpc/server'
import { type RpcContext, rpc } from '../../../platform/rpc.ts'
import type { AclAudit } from '../../audit/index.ts'
import { DreamForbidden, DreamRefused, type DreamService } from './service.ts'

/** The resource kind of a diary in the owner-access audit row (`acl.owner-access`). */
export const DREAM_DIARY_KIND = 'dream-diary'
/** The ACL read bit (`r` = 4): what the owner's read of a diary is. */
const READ_BIT = 4

export interface DreamProcedureDeps {
  service: DreamService
  owner: { isOwner(personId: string): Promise<boolean> }
  people: { get(personId: string): Promise<unknown> }
  /** The owner's audited read of a member's diary (ADR-0020 §4). */
  aclAudit: Pick<AclAudit, 'ownerAccess'>
  /** The dreaming settings in force, and their change (the settings table, `dreaming.*` keys). */
  settings: {
    read(): DreamingSettings
    write(change: DreamingSettingsSet): void
  }
  /** Re-syncs the `dream` built-in of every person (a change of the member default or of the cap moves them). */
  syncEveryone(): Promise<void>
}

/**
 * A refusal of the service as the RPC error of its code: `CONFLICT` with `data.reason`, `FORBIDDEN` for another person's mode.
 * Awaits the call: `runNow`, `apply` are async, and their refusals are rejections, not throws.
 */
async function refusing<T>(call: () => T | Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof DreamRefused)
      throw new ORPCError('CONFLICT', {
        message: `dreaming refused: ${error.reason}`,
        data: { reason: error.reason },
      })
    if (error instanceof DreamForbidden)
      throw new ORPCError('FORBIDDEN', { message: error.message })
    throw error
  }
}

const personOf = (context: RpcContext): string => context.principal.personId

export function dreamProcedures(deps: DreamProcedureDeps) {
  const { service } = deps
  /** The view of a run of the caller; a run that did not start (mode `off`) has no row, so it is a refusal. */
  const viewOfRun = (personId: string, runId: string | null, reason: string): DreamRunView => {
    if (runId === null) throw new ORPCError('CONFLICT', { message: reason, data: { reason } })
    const view = service.runView(personId, runId)
    if (view === undefined) throw new ORPCError('NOT_FOUND', { message: 'there is no such run' })
    return view
  }

  return {
    status: rpc.dream.status.handler(
      ({ context }): Promise<DreamStatusView> => service.status(personOf(context)),
    ),
    mode: rpc.dream.mode.handler(async ({ input, context }): Promise<DreamStatusView> => {
      const caller = personOf(context)
      await refusing(() => service.setMode(caller, caller, input.mode))
      return service.status(caller)
    }),
    now: rpc.dream.now.handler(async ({ context }): Promise<DreamRunView> => {
      const caller = personOf(context)
      const result = await refusing(() => service.runNow(caller))
      return viewOfRun(caller, result.runId, result.reason ?? result.status)
    }),
    apply: rpc.dream.apply.handler(async ({ input, context }): Promise<DreamRunView> => {
      const caller = personOf(context)
      const applied = await refusing(() => service.apply(caller, input.runId))
      return viewOfRun(caller, applied.runId, 'no-run')
    }),
    undo: rpc.dream.undo.handler(async ({ input, context }) => {
      const restored = await refusing(() => service.undo(personOf(context), input.runId))
      return { runId: restored.runId, restored: restored.restored, skipped: restored.skipped }
    }),
    diary: rpc.dream.diary.handler(async ({ input, context }): Promise<DreamDiaryOutput> => {
      const caller = personOf(context)
      const target = input.personId ?? caller
      if (target !== caller) {
        // a member reads nobody else's diary: the same answer as a person who does not exist
        if (!(await deps.owner.isOwner(caller)))
          throw new ORPCError('NOT_FOUND', { message: 'there is no such diary' })
        if ((await deps.people.get(target).catch(() => undefined)) === undefined)
          throw new ORPCError('NOT_FOUND', { message: 'there is no such diary' })
        deps.aclAudit.ownerAccess(
          { by: caller, via: context.via },
          {
            kind: DREAM_DIARY_KIND,
            bits: READ_BIT,
            resources: [{ id: target, owner: target }],
          },
        )
      }
      const diary = service.diary(target, input.date)
      if (diary === undefined)
        throw new ORPCError('NOT_FOUND', { message: 'there is no diary yet' })
      return diary
    }),
    settings: {
      get: rpc.dream.settings.get.handler((): DreamingSettings => deps.settings.read()),
      set: rpc.dream.settings.set.handler(async ({ input, context }): Promise<DreamingSettings> => {
        // the member default and the cap are the owner's: the procedure checks it, not only the capability
        if (!(await deps.owner.isOwner(personOf(context))))
          throw new ORPCError('FORBIDDEN', { message: 'only the owner sets the dreaming settings' })
        const from = deps.settings.read()
        deps.settings.write(input)
        const to = deps.settings.read()
        context.record('settings.dreaming.set', { from, to })
        await deps.syncEveryone()
        return to
      }),
    },
  }
}

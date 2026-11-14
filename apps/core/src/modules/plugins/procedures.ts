import { type CapabilityRegistry, OWNER_ONLY_CAPABILITIES } from '@keith/contracts'
import type { ViewHost } from '@keith/host/views'
import { ORPCError } from '@orpc/server'
import { rpc } from '../../platform/rpc.ts'
import type { RecordAudit } from '../audit/index.ts'
import { type PluginAdmin, PluginAdminError } from './admin.ts'
import { ReviewError, type ReviewService } from './reviews.ts'

const mapped = <T>(run: () => Promise<T>): Promise<T> =>
  run().catch((error: unknown) => {
    if (error instanceof PluginAdminError)
      throw new ORPCError(error.code, { message: error.message })
    if (error instanceof ReviewError) throw new ORPCError(error.code, { message: error.message })
    throw error
  })

/**
 * oRPC `admin.reviews.*` over the review service. Authority is `reviews.decide` (owner only); approve and deny are
 * `sensitive` (a remote caller needs a step-up, checked by the rpc layer before the handler runs).
 */
export function reviewProcedures(service: ReviewService) {
  const caller = (context: { principal: { personId: string }; via: 'local' | 'tcp' }) => ({
    by: context.principal.personId,
    via: context.via,
  })
  return {
    list: rpc.admin.reviews.list.handler(({ input }) =>
      mapped(() => service.list({ status: input.status, limit: input.limit })),
    ),
    approve: rpc.admin.reviews.approve.handler(({ input, context }) =>
      mapped(() => service.approve(input.id, caller(context))),
    ),
    deny: rpc.admin.reviews.deny.handler(({ input, context }) =>
      mapped(() => service.deny(input.id, input.reason, caller(context))),
    ),
  }
}

/**
 * oRPC `admin.plugins.*` and `admin.capabilities.list`. Owner only (`plugins.manage`); enable and disable are
 * `sensitive` and audited, and only save the setting (the next boot applies it).
 */
export function pluginProcedures(
  admin: PluginAdmin,
  capabilities: CapabilityRegistry,
  views?: Pick<ViewHost, 'snapshot'>,
) {
  const owner = new Set<string>(OWNER_ONLY_CAPABILITIES)
  const toggle = (enabled: boolean) => (input: { id: string }, context: { record: RecordAudit }) =>
    mapped(async () => {
      const done = await admin.setEnabled(input.id, enabled)
      context.record(enabled ? 'plugin.enabled' : 'plugin.disabled', {
        plugin: input.id,
        changed: done.changed,
        effective: done.effective,
      })
      return done
    })
  return {
    plugins: {
      list: rpc.admin.plugins.list.handler(() => mapped(() => admin.list())),
      views: {
        list: rpc.admin.plugins.views.list.handler(() =>
          (views?.snapshot() ?? []).map((v) => ({
            id: v.id,
            viewId: v.viewId,
            personId: v.principalId,
            openedAt: v.openedAt,
          })),
        ),
      },
      show: rpc.admin.plugins.show.handler(({ input }) => mapped(() => admin.show(input.id))),
      enable: rpc.admin.plugins.enable.handler(({ input, context }) =>
        toggle(true)(input, context),
      ),
      disable: rpc.admin.plugins.disable.handler(({ input, context }) =>
        toggle(false)(input, context),
      ),
    },
    capabilities: {
      list: rpc.admin.capabilities.list.handler(() => {
        const declared = new Map(capabilities.declared().map((d) => [d.id, d]))
        return capabilities.ids().map((id) => ({
          id,
          owner: declared.get(id)?.owner ?? 'core',
          description: declared.get(id)?.description ?? null,
          ownerOnly: owner.has(id),
        }))
      }),
    },
  }
}

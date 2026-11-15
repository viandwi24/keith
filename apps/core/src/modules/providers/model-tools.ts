// The model tools of the front agent (docs/specs/providers.md "Tools in conversation"; ADR-0034 §8). `model_roles_get` is the
// owner's read; `model_role_set` is the owner's switch of the model of a role, a reversible write (ADR-0036): in a clean conversation
// it runs and records an undo (`undo_last`), after outside content it waits as an approval (`amygdala/consent.ts`), and answering that
// approval from a remote client needs a step-up (`STEP_UP_TOOLS`, `amygdala/attention.ts`). It goes through `ProviderService.setRole`, the call behind `keith-core model set`
// and `models.roles.set`, so validation is the same (an unknown connection or model is refused) and so is the audit row
// (`settings.model.set`). A refusal is an answer `{ ok: false, reason, message }`, never a throw.
import { ModelRefSchema, ModelRoleSchema, type ModelRoles } from '@keith/contracts'
import { tool } from 'ai'
import { definePlugin, type HarnessContext, type HarnessPlugin, isHarnessError } from 'eharness'
import { z } from 'zod'
import { recordUndo, type UndoLog } from '../../platform/undo-log.ts'
import type { Audit } from '../audit/index.ts'
import type { ProviderService } from './service.ts'

export const MODEL_TOOLS_PLUGIN = 'keith-providers-model-tools'
export const MODEL_ROLES_GET_TOOL = 'model_roles_get'
export const MODEL_ROLE_SET_TOOL = 'model_role_set'

export interface ModelToolsDeps {
  providers: Pick<ProviderService, 'roles' | 'setRole'>
  audit: Pick<Audit, 'record'>
  /** Whether the person is the owner (the people directory); an unknown person is not. */
  isOwner(personId: string): Promise<boolean>
  /** Where a switch records how to take itself back (`undo_last`). Absent: no undo is kept. */
  undo?: UndoLog
}

export interface ModelToolRefusal {
  ok: false
  reason: string
  message: string
}

const refusal = (reason: string, message: string): ModelToolRefusal => ({
  ok: false,
  reason,
  message,
})

const SetInput = z.object({ role: ModelRoleSchema, model: ModelRefSchema })

/** The tools of one turn (factories: the person is read from the turn context when a tool runs). */
export function modelToolsOf(deps: ModelToolsDeps) {
  const { providers, audit } = deps

  /** The owner's id, or the refusal that explains why the call is not theirs. */
  const ownerOf = async (ctx: HarnessContext): Promise<string | ModelToolRefusal> => {
    const id = ctx.principal?.id
    if (id === undefined) return refusal('no-person', 'no person is talking in this chat')
    if (!(await deps.isOwner(id)))
      return refusal('not-owner', 'only the owner may read or change the model of a role')
    return id
  }

  return {
    [MODEL_ROLES_GET_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          'Owner only. List the model picked for each role (front, cortex, guest) as connection:model, null when none is picked. ',
        inputSchema: z.object({}),
        metadata: { risk: 'read', source: 'trusted' },
        execute: async () => {
          const who = await ownerOf(ctx)
          if (typeof who !== 'string') return who
          return { ok: true as const, roles: await providers.roles() }
        },
      }),

    [MODEL_ROLE_SET_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          'Owner only. Pick the model of a role: role is front (talks with people), cortex (works in the background) or guest (guest chats); model is connection:model, for example openrouter:anthropic/claude-sonnet-5.5. An unknown connection or model is refused. Runs at once when the owner just asked for it; "undo_last" takes it back.',
        inputSchema: SetInput,
        metadata: { risk: 'write', reversible: true, source: 'trusted' },
        execute: async ({ role, model }: z.infer<typeof SetInput>) => {
          const who = await ownerOf(ctx)
          if (typeof who !== 'string') return who
          try {
            const previous = (await providers.roles())[role as keyof ModelRoles] ?? null
            const roles = await providers.setRole(role, model)
            audit.record({
              kind: 'settings.model.set',
              actor: who,
              via: 'local',
              detail: { role, ref: model },
            })
            if (previous !== null)
              recordUndo(deps.undo, ctx, {
                tool: MODEL_ROLE_SET_TOOL,
                summary: `the ${role} model as it was`,
                undo: async () => {
                  await providers.setRole(role, previous)
                  audit.record({
                    kind: 'settings.model.set',
                    actor: who,
                    via: 'local',
                    detail: { role, ref: previous },
                  })
                  return { ok: true, summary: `the ${role} model is back to ${previous}` }
                },
              })
            return { ok: true as const, role, model, roles }
          } catch (error) {
            if (isHarnessError(error) && error.code === 'EH_CONFIG_INVALID')
              return refusal('unknown-model', error.message)
            throw error
          }
        },
      }),
  }
}

/** Plugin of the model tools: the front agent only (the personal session); rooms and workers have none. */
export function createModelToolsPlugin(
  deps: ModelToolsDeps,
): HarnessPlugin<typeof MODEL_TOOLS_PLUGIN> {
  return definePlugin({
    name: MODEL_TOOLS_PLUGIN,
    setup: () => ({
      tools: modelToolsOf(deps),
    }),
  })
}

// The `undo_last` tool (ADR-0036 §4, docs/specs/amygdala.md "Undo"): takes the newest reversible change of the person in this chat back.
import { tool } from 'ai'
import { definePlugin, type HarnessContext, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import type { UndoLog, UndoResult } from '../../platform/undo-log.ts'

export const UNDO_LAST_TOOL = 'undo_last'
export const UNDO_PLUGIN = 'keith-undo'

export const UNDO_LAST_DESCRIPTION =
  "Undo the speaker's own last reversible change in this chat: a persona change, their style, a model role or their presence status that Keith just made. Call it when the person says undo, revert or switch back. It restores what was there before and says what it restored."

/**
 * Plugin of `undo_last`: the front agent only. A reversible write itself (clean-only by the consent table), but it records no
 * undo of its own: a second "undo" takes the change before.
 */
export function createUndoPlugin(log: UndoLog): HarnessPlugin<typeof UNDO_PLUGIN> {
  return definePlugin({
    name: UNDO_PLUGIN,
    setup: () => ({
      tools: {
        [UNDO_LAST_TOOL]: (ctx: HarnessContext) =>
          tool({
            description: UNDO_LAST_DESCRIPTION,
            inputSchema: z.object({}),
            metadata: { risk: 'write', reversible: true, source: 'trusted' },
            execute: async (): Promise<UndoResult> => {
              const person = ctx.principal?.id
              if (person === undefined)
                return {
                  ok: false,
                  reason: 'no-person',
                  message: 'no person is talking in this chat',
                }
              const entry = log.take(ctx.session.id, person)
              if (entry === undefined)
                return {
                  ok: false,
                  reason: 'nothing-to-undo',
                  message: 'there is no earlier change of yours in this chat to take back',
                }
              try {
                return await entry.undo()
              } catch (error) {
                return {
                  ok: false,
                  reason: 'undo-failed',
                  message:
                    error instanceof Error ? error.message : 'the change could not be undone',
                }
              }
            },
          }),
      },
    }),
  })
}

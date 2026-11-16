// The persona and style tools of the front agent (docs/specs/prefrontal.md "Tools in conversation"; ADR-0034 §3). `style_get` and
// `style_set` act on the speaker's own style only: the person is `ctx.principal`, no argument names a person. `persona_get`,
// `persona_template`, `persona_edit` and `persona_restore` are the owner's: the persona service refuses a member (`not-owner`).
// The persona and style changes are reversible writes (ADR-0036): in a clean conversation (the person's own words asked, nothing
// outside read since) they run at once and record an undo (`undo_last`); after outside content they wait as an approval
// (`amygdala/consent.ts` decides from the tool metadata `risk`, `reversible` and `source`, not from this file). Answering such an
// approval from a remote client needs a step-up (`amygdala/attention.ts`, `STEP_UP_TOOLS`). Every change goes through the same
// services as the RPC path, so validation and audit rows are identical, and so are the audit rows of an undo.
// A refusal is an answer `{ ok: false, reason, message }`, never a throw, so the model can tell the person what happened.
import {
  PersonaPatchSchema,
  PersonaTemplateSchema,
  PersonStylePatchSchema,
  STEP_UP_TOOLS,
} from '@keith/contracts'
import { tool } from 'ai'
import { definePlugin, type HarnessContext, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import { recordUndo, type UndoLog } from '../../platform/undo-log.ts'
import { type PersonaService, type PrefrontalCaller, PrefrontalError } from './service.ts'
import type { PersonStyleService } from './style.ts'

export const PERSONA_TOOLS_PLUGIN = 'keith-prefrontal-persona-tools'
export const STYLE_GET_TOOL = 'style_get'
export const STYLE_SET_TOOL = 'style_set'
export const PERSONA_GET_TOOL = 'persona_get'
export const PERSONA_TEMPLATE_TOOL = 'persona_template'
export const PERSONA_EDIT_TOOL = 'persona_edit'
export const PERSONA_RESTORE_TOOL = 'persona_restore'

/** The persona changes: reversible writes that ask when tainted (a subset of `STEP_UP_TOOLS`; `persona_get` is a read and is not in it). */
export const PERSONA_APPROVAL_TOOLS: readonly string[] = STEP_UP_TOOLS.filter((name) =>
  name.startsWith('persona_'),
)

export interface PersonaToolsDeps {
  persona: Pick<PersonaService, 'get' | 'history' | 'setTemplate' | 'edit' | 'restore'>
  styles: Pick<PersonStyleService, 'get' | 'set' | 'has' | 'ensure'>
  /** Where a change records how to take itself back (`undo_last`). Absent: no undo is kept. */
  undo?: UndoLog
}

export interface ToolRefusal {
  ok: false
  reason: string
  message: string
}

const refusal = (reason: string, message: string): ToolRefusal => ({ ok: false, reason, message })

/** The shapes without the "empty patch" refinement: an empty style patch is `skip`, an empty persona patch is refused by the service. */
const StyleSetInput = z.object(PersonStylePatchSchema.shape)
const PersonaEditInput = z.object(PersonaPatchSchema.shape)

/**
 * The caller of a tool call. A style change is the person's own; a persona change is the owner's (the persona service refuses a
 * member). The call is elevated: consent already decided (ADR-0036), and the step-up of an approval answer is checked by `canAnswer`.
 */
const callerOf = (ctx: HarnessContext): PrefrontalCaller | undefined =>
  ctx.principal?.id === undefined
    ? undefined
    : { by: ctx.principal.id, via: 'local', elevated: true }

/** Runs `act` as the turn's person; a service refusal becomes an answer. */
async function asCaller<T>(
  ctx: HarnessContext,
  act: (caller: PrefrontalCaller) => T | Promise<T>,
): Promise<T | ToolRefusal> {
  const caller = callerOf(ctx)
  if (caller === undefined) return refusal('no-person', 'no person is talking in this chat')
  try {
    return await act(caller)
  } catch (error) {
    if (error instanceof PrefrontalError)
      return refusal(error.reason ?? error.code.toLowerCase(), error.message)
    throw error
  }
}

/** The tools of one turn (factories: the person is read from the turn context when a tool runs). */
export function personaToolsOf(deps: PersonaToolsDeps) {
  const { persona, styles } = deps

  const currentPersona = () => {
    const view = persona.get()
    return view === undefined
      ? refusal('no-persona', 'there is no persona yet')
      : { ok: true as const, version: view.version, template: view.templateId, body: view.body }
  }

  /** The undo of a persona change: the version before it, restored through the same service (audited as `persona.restore`). */
  const rememberPersona = (
    ctx: HarnessContext,
    caller: PrefrontalCaller,
    toolName: string,
    before: number | undefined,
  ): void => {
    if (before === undefined) return
    recordUndo(deps.undo, ctx, {
      tool: toolName,
      summary: 'the persona as it was',
      undo: async () => {
        try {
          await persona.restore(caller, before)
        } catch (error) {
          if (error instanceof PrefrontalError)
            return {
              ok: false,
              reason: error.reason ?? error.code.toLowerCase(),
              message: error.message,
            }
          throw error
        }
        return { ok: true, summary: 'the persona is back as it was' }
      },
    })
  }

  return {
    [STYLE_GET_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          "Read the speaker's own style (how they want to be addressed, language, brevity, formality, gentle topics) and whether it was ever saved.",
        inputSchema: z.object({}),
        metadata: { risk: 'read', source: 'trusted' },
        execute: () =>
          asCaller(ctx, (caller) => ({
            ok: true as const,
            stored: styles.has(caller),
            style: styles.get(caller),
          })),
      }),

    [STYLE_SET_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          "Save the speaker's own style: address (a name or form of address, null clears it), language (auto or a BCP 47 tag), brevity (short, normal, full), formality (casual, neutral, formal), gentleTopics. Pass only what the person chose. With no field at all it stores the defaults (when the person skips onboarding). Never for another person.",
        inputSchema: StyleSetInput,
        metadata: { risk: 'write', reversible: true, source: 'trusted' },
        execute: (input: z.infer<typeof StyleSetInput>) =>
          asCaller(ctx, (caller) => {
            const given = Object.values(input).some((value) => value !== undefined)
            const before = styles.get(caller)
            const style = given ? styles.set(caller, input) : styles.ensure(caller)
            if (given)
              recordUndo(deps.undo, ctx, {
                tool: STYLE_SET_TOOL,
                summary: 'your style as it was',
                undo: () => {
                  styles.set(caller, before)
                  return { ok: true, summary: 'your style is back as it was' }
                },
              })
            return { ok: true as const, style }
          }),
      }),

    [PERSONA_GET_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          'Owner only. Read the current persona (version, template and the character fields).',
        inputSchema: z.object({}),
        metadata: { risk: 'read', source: 'trusted' },
        execute: () =>
          asCaller(ctx, async (caller) => {
            // the persona text is readable by everyone who can chat, but this tool is the owner's (ADR-0034 §3):
            // the history read is the owner gate
            await persona.history(caller, 1)
            return currentPersona()
          }),
      }),

    [PERSONA_TEMPLATE_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          'Owner only. Switch the persona to a built-in template (butler, friend or professional). Runs at once when the owner just asked for it; "undo_last" takes it back.',
        inputSchema: z.object({ template: PersonaTemplateSchema }),
        metadata: { risk: 'write', reversible: true, source: 'trusted', effect: 'behavior' },
        execute: ({ template }: { template: z.infer<typeof PersonaTemplateSchema> }) =>
          asCaller(ctx, async (caller) => {
            const before = persona.get()?.version
            await persona.setTemplate(caller, template)
            rememberPersona(ctx, caller, PERSONA_TEMPLATE_TOOL, before)
            return currentPersona()
          }),
      }),

    [PERSONA_EDIT_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          'Owner only. Change fields of the persona: tone, attitude, humour (none, dry, warm), addressing, caresAbout, lines. Pass only the fields to change. Runs at once when the owner just asked for it; "undo_last" takes it back.',
        inputSchema: PersonaEditInput,
        metadata: { risk: 'write', reversible: true, source: 'trusted', effect: 'behavior' },
        execute: (input: z.infer<typeof PersonaEditInput>) =>
          asCaller(ctx, async (caller) => {
            const before = persona.get()?.version
            await persona.edit(caller, input)
            rememberPersona(ctx, caller, PERSONA_EDIT_TOOL, before)
            return currentPersona()
          }),
      }),

    [PERSONA_RESTORE_TOOL]: (ctx: HarnessContext) =>
      tool({
        description:
          'Owner only. Restore an older persona version (writes a new version with its content). Runs at once when the owner just asked for it; "undo_last" takes it back.',
        inputSchema: z.object({ version: z.number().int().min(1) }),
        metadata: { risk: 'write', reversible: true, source: 'trusted', effect: 'behavior' },
        execute: ({ version }: { version: number }) =>
          asCaller(ctx, async (caller) => {
            const before = persona.get()?.version
            await persona.restore(caller, version)
            rememberPersona(ctx, caller, PERSONA_RESTORE_TOOL, before)
            return currentPersona()
          }),
      }),
  }
}

/** Plugin of the persona and style tools: the front agent only (the personal session); rooms and workers have none. */
export function createPersonaToolsPlugin(
  deps: PersonaToolsDeps,
): HarnessPlugin<typeof PERSONA_TOOLS_PLUGIN> {
  return definePlugin({
    name: PERSONA_TOOLS_PLUGIN,
    setup: () => ({
      tools: personaToolsOf(deps),
    }),
  })
}

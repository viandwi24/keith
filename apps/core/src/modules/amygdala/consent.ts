// Conversational consent (ADR-0036, docs/specs/amygdala.md "Consent"): the `tool.approve` hook that answers from risk × clean/tainted,
// and the registry that keeps what it decided by tool call so a re-validation answers the same and the attention list can say how a
// waiting call is confirmed. In memory: a restart forgets it, and a call whose tier is unknown counts as a device confirmation.
import {
  type ConsentContext,
  type ConsentTier,
  STEP_UP_TOOLS,
  type ToolSource,
} from '@keith/contracts'
import { eharnessConsentRisk, toolReversible, toolSelfConfirmed, toolSource } from '@keith/eh-ext'
import { definePlugin, type HarnessPlugin, type ToolRisk, type TurnKind } from 'eharness'
import { type ConsentOrigin, consentContext } from './consent-context.ts'
import { consentDecision } from './consent-table.ts'

export const CONSENT_PLUGIN = 'keith-consent'

/** What a turn that started in a front session was: the person's own message, or something else (a wake). */
type Trigger = 'person' | 'wake'

interface Decided {
  context: ConsentContext
  tier?: ConsentTier
  /** The step-up fact of the first decision (a step-up tool asked by a client that had not stepped up). */
  stepUp?: boolean
}

/** Read side of the registry: what the attention list and the workers need. */
export interface ConsentRegistry {
  /** How a waiting call is confirmed; undefined when unknown (the caller treats it as `device`). */
  tierOf(sessionId: string, toolCallId: string): ConsentTier | undefined
  /** The context of a decided call; undefined when unknown. */
  contextOf(sessionId: string, toolCallId: string): ConsentContext | undefined
}

export interface ConsentOptions {
  /**
   * The risk consent reads for a call, when the tool's own risk is too coarse: `motor_remote` is `external` as a tool, but a
   * `system.info` call runs unasked (motor.md). Undefined: the tool's risk (`e.risk`), with eharness' web tools read as `read`.
   */
  riskOf?: (toolName: string, input: unknown) => ToolRisk | undefined
  /**
   * Whether the person's client that last wrote in the chat had stepped up (`false`: no, `undefined`: no client is known, which
   * counts as no). A step-up tool (`STEP_UP_TOOLS`) asked by a client that has not waits on a device whatever the conversation
   * says (permissions.md). Absent: every client counts as stepped up (tests that build the hook alone).
   */
  elevatedOf?: (personId: string) => boolean | undefined
  /**
   * Calls whose answer needs a step-up besides `STEP_UP_TOOLS` (a shell command: `ownerAnswers`, amygdala `canAnswer`). Asked by a
   * client that has not stepped up, they wait on a device too: a "yes" in the chat could not answer them (the answer route asks for the
   * step-up), so asking in the conversation would only confuse.
   */
  stepUpCall?: (toolName: string, input: unknown) => boolean
  /** Bound of the remembered decisions (default 5000; the oldest go first). */
  max?: number
}

export interface Consent {
  registry: ConsentRegistry
  /** The hook plugin of one agent: `front` (the person's session) or `worker` (a delegated task). */
  plugin(role: 'front' | 'worker'): HarnessPlugin<typeof CONSENT_PLUGIN>
  /** Test seam: the source the hooks learned for a tool name. */
  learnedSource(toolName: string): ToolSource | undefined
}

const keyOf = (sessionId: string, toolCallId: string): string => `${sessionId}|${toolCallId}`

/** The trigger of a turn kind: a `send` or an `edit` is the person's; a `wake` is not; the rest continue what was running. */
const triggerOf = (kind: TurnKind): Trigger | undefined =>
  kind === 'send' || kind === 'edit' ? 'person' : kind === 'wake' ? 'wake' : undefined

export function createConsent(options: ConsentOptions = {}): Consent {
  const max = options.max ?? 5000
  const decided = new Map<string, Decided>()
  const triggers = new Map<string, Trigger>()
  /** Traits learned by tool name from the metadata each reviewed call carried (the transcript names tools, not their metadata). */
  const learned = new Map<string, { source: ToolSource; reversible: boolean }>()
  /** Tools seen with `selfConfirmed` metadata, by name (re-validation passes calls without their metadata). */
  const selfConfirmed = new Set<string>()

  const remember = (key: string, value: Decided): void => {
    decided.set(key, value)
    if (decided.size > max) decided.delete(decided.keys().next().value as string)
  }
  const sourceOf = (toolName: string): ToolSource =>
    learned.get(toolName)?.source ?? toolSource(undefined, toolName)

  const registry: ConsentRegistry = {
    tierOf: (sessionId, toolCallId) => decided.get(keyOf(sessionId, toolCallId))?.tier,
    contextOf: (sessionId, toolCallId) => decided.get(keyOf(sessionId, toolCallId))?.context,
  }

  return {
    registry,
    learnedSource: (toolName) => learned.get(toolName)?.source,
    plugin: (role) =>
      definePlugin({
        name: CONSENT_PLUGIN,
        setup: () => ({
          hooks: {
            // the trigger of a front session's latest turn, by session: a `respond` or a `regenerate` continues the one before it
            'turn.start': (ctx, e) => {
              if (role !== 'front') return
              const trigger = triggerOf(e.kind)
              if (trigger === undefined) return
              triggers.delete(ctx.session.id)
              triggers.set(ctx.session.id, trigger)
              if (triggers.size > max) triggers.delete(triggers.keys().next().value as string)
            },
            'tool.approve': (ctx, e) => {
              // a tool with its own confirmation step (room_post): the person confirms there, never twice
              if (toolSelfConfirmed(e.toolMetadata) || selfConfirmed.has(e.toolName)) {
                selfConfirmed.add(e.toolName)
                return undefined
              }
              const key = keyOf(ctx.session.id, e.toolCallId)
              if (e.toolMetadata !== undefined)
                learned.set(e.toolName, {
                  source: toolSource(e.toolMetadata, e.toolName),
                  reversible: toolReversible(e.toolMetadata),
                })
              const known = decided.get(key)
              const reversible =
                e.toolMetadata === undefined
                  ? (learned.get(e.toolName)?.reversible ?? false)
                  : toolReversible(e.toolMetadata)
              let context = known?.context
              if (context === undefined) {
                const origin = originOf(role, ctx.session)
                try {
                  context = consentContext({
                    transcript: e.transcript(),
                    sourceOf,
                    origin,
                  })
                } catch {
                  context = 'tainted'
                }
              }
              const risk =
                options.riskOf?.(e.toolName, e.input) ?? eharnessConsentRisk(e.toolName) ?? e.risk
              const stepUp = known?.stepUp ?? needsStepUp(e.toolName, e.input, ctx.principal?.id)
              const decision = consentDecision({ risk, reversible, context, stepUp })
              if (known === undefined)
                remember(key, {
                  context,
                  ...(stepUp ? { stepUp } : {}),
                  ...(decision?.status === 'user-approval' ? { tier: decision.tier } : {}),
                })
              if (decision === undefined) return undefined
              if (decision.status === 'approved') return 'approved'
              return {
                type: 'user-approval' as const,
                reason: `${e.toolName}: ${decision.tier === 'conversation' ? 'asked in the conversation' : 'confirm on a trusted device'}`,
              }
            },
          },
        }),
      }),
  }

  /** A step-up tool asked while the client of the person has not stepped up (or is not known). */
  function needsStepUp(toolName: string, input: unknown, personId: string | undefined): boolean {
    if (options.elevatedOf === undefined) return false
    if (!STEP_UP_TOOLS.includes(toolName) && options.stepUpCall?.(toolName, input) !== true)
      return false
    return personId === undefined || options.elevatedOf(personId) !== true
  }

  /** The origin of the turn that makes a call, from the agent role and, for a worker, the front call that delegated it. */
  function originOf(
    role: 'front' | 'worker',
    session: { id: string; parent?: { sessionId: string; toolCallId?: string } },
  ): ConsentOrigin {
    if (role === 'front') return triggers.get(session.id) === 'person' ? 'person' : 'tainted'
    const parent = session.parent
    if (parent?.toolCallId === undefined) return 'tainted'
    return decided.get(keyOf(parent.sessionId, parent.toolCallId))?.context === 'clean'
      ? 'delegated-clean'
      : 'tainted'
  }
}

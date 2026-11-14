import { GUEST_LIMITS, type GuestEndReason } from '@keith/contracts'
import { definePlugin, type HarnessPlugin } from 'eharness'

/** What one guest session counts about itself (numbers only: never text). */
export interface GuestSessionStats {
  turns: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  startedAt: number
  lastActiveAt: number
  /** A turn is running: the idle clock waits for it. */
  busy: boolean
  /** Calls per tool name. */
  tools: Record<string, number>
  /** Refusals per kind: `input-too-long`, `file-part`, `turn-cap`, `tool-denied`, `cost-cap`, `ended`. */
  refusals: Record<string, number>
}

export const newStats = (now: number): GuestSessionStats => ({
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  startedAt: now,
  lastActiveAt: now,
  busy: false,
  tools: {},
  refusals: {},
})

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1
}

export interface GuestLimitsOptions {
  stats: GuestSessionStats
  maxTurns: number
  /** The names of the tools a guest may call; every other call is denied. */
  allowTools: readonly string[]
  now: () => number
  /** Asked once a cap ends the session; the registry closes it after a short grace so the last answer is delivered. */
  requestEnd: (reason: GuestEndReason) => void
  /** The model of the next turn (never throws). */
  model: () => Promise<import('ai').LanguageModel>
  /** Set when the session already ended: new input is refused. */
  ended: () => boolean
}

const partsOf = (message: { parts?: Array<{ type: string; text?: string }> }) => message.parts ?? []

/**
 * Plugin of a guest agent: the model of the `guest` role per turn, only the allow-listed tools (hidden from the
 * model and denied at approval), the input rules (2 KiB of text, no file parts, a turn cap) and the counters the
 * session's one audit row is made of. Holds no text: a rejected message is dropped (`persist: false`).
 */
export function guestLimits(options: GuestLimitsOptions): HarnessPlugin<'guest-limits'> {
  const { stats, now } = options
  const allowed = new Set(options.allowTools)
  const refuse = (kind: string, reason: string) => {
    bump(stats.refusals, kind)
    return { block: { reason, persist: false } }
  }
  return definePlugin({
    name: 'guest-limits',
    setup: () => ({
      hooks: {
        'input.submit': (_ctx, e) => {
          stats.lastActiveAt = now()
          if (options.ended()) return refuse('ended', 'This chat has ended.')
          const parts = partsOf(e.message)
          if (parts.some((p) => p.type !== 'text'))
            return refuse('file-part', 'Only text messages are accepted here.')
          const chars = parts.reduce((n, p) => n + (p.text?.length ?? 0), 0)
          if (chars > GUEST_LIMITS.maxInputChars)
            return refuse(
              'input-too-long',
              `That message is too long (the limit is ${GUEST_LIMITS.maxInputChars} characters).`,
            )
          if (stats.turns >= options.maxTurns)
            return refuse('turn-cap', 'This chat reached its message limit. Start a new one.')
          stats.turns += 1
          stats.busy = true
        },
        'turn.prepare': async () => ({
          model: await options.model(),
          activeTools: [...allowed],
        }),
        'tool.approve': (_ctx, e) =>
          allowed.has(e.toolName)
            ? undefined
            : { type: 'denied' as const, reason: 'This tool is not available to visitors.' },
        'approval.decided': (_ctx, e) => {
          if (!e.approved) bump(stats.refusals, 'tool-denied')
        },
        'tool.after': (_ctx, e) => {
          bump(stats.tools, e.toolName)
        },
        'turn.end': (_ctx, result) => {
          stats.busy = false
          stats.lastActiveAt = now()
          stats.inputTokens += result.usage.inputTokens
          stats.outputTokens += result.usage.outputTokens
          stats.costUsd += result.usage.costUsd ?? 0
          if (result.stop === 'cost-cap') {
            bump(stats.refusals, 'cost-cap')
            options.requestEnd('cost-cap')
          } else if (stats.turns >= options.maxTurns) options.requestEnd('turn-cap')
        },
      },
    }),
  })
}

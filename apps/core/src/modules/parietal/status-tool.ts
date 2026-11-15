// The `presence_status_set` tool of the front agent (docs/specs/parietal.md, "The presence_status_set tool", ADR-0034 §5):
// the speaker states, in conversation, that they are `busy` or `out` (from a time, until a time) or clears it. The person is
// the turn's principal, never an argument: it changes the speaker's own status and nobody else's. It is audited like
// `presence.status.set` of the RPC and the audit never holds the note.
import type { PresenceStatusKind, PresenceStatusSet, PresenceStatusView } from '@keith/contracts'
import { tool } from 'ai'
import type { HarnessContext } from 'eharness'
import { z } from 'zod'
import { recordUndo, type UndoLog } from '../../platform/undo-log.ts'
import type { AclActors } from '../acl/index.ts'
import type { Audit } from '../audit/index.ts'
import { ParietalError, type ParietalService } from './service.ts'

export const PRESENCE_STATUS_SET_TOOL = 'presence_status_set'

export interface PresenceStatusToolOptions {
  parietal: Pick<ParietalService, 'setStatus'> & Partial<Pick<ParietalService, 'status'>>
  actors: AclActors
  /** Writes `presence.status.set` (`{ subject, busy, kind, minutes }`, never the note). Absent in tests that do not audit. */
  audit?: Pick<Audit, 'record'>
  now?: () => number
  /** Where a change records how to take itself back (`undo_last`). Absent: no undo is kept. */
  undo?: UndoLog
}

/** What the tool answers: the stored status, or the reason it was refused. */
export type PresenceStatusSetAnswer =
  | { ok: true; status: 'busy' | 'out' | 'cleared'; from: string | null; until: string | null }
  | { ok: false; reason: string }

/** A time as the model gives it: an ISO time with a zone (`2026-11-14T15:00:00+07:00`) or minutes from now. */
const TimeSchema = z.union([z.string().min(1).max(40), z.number().int().min(0).max(20_160)])

const INPUT = z.object({
  kind: z
    .enum(['busy', 'out', 'clear'])
    .describe('busy = do not disturb; out = away from the desk; clear = no status'),
  from: TimeSchema.optional().describe(
    'when it starts: ISO time with a zone, or minutes from now; default now',
  ),
  until: TimeSchema.optional().describe(
    'when it ends: ISO time with a zone, or minutes from now; default a day',
  ),
  note: z.string().max(200).optional().describe('a short note, at most 200 characters'),
})

export const PRESENCE_STATUS_SET_DESCRIPTION =
  "Sets or clears the speaker's own presence status: busy (do not disturb) or out (away from the desk, reachable on a phone or chat), from a time and until a time, with an optional note. Times are an ISO time with a zone offset, or minutes from now. It never changes another person's status."

const ZONE = /(Z|[+-]\d{2}:?\d{2})$/i

/** Epoch ms of a time given as minutes from `now` or as an ISO time with a zone; undefined when it does not parse. */
export function parseStatusTime(value: string | number, now: number): number | undefined {
  if (typeof value === 'number') return now + value * 60_000
  if (!ZONE.test(value.trim())) return undefined
  const at = Date.parse(value.trim())
  return Number.isNaN(at) ? undefined : at
}

const iso = (at: number | null | undefined): string | null =>
  at === null || at === undefined ? null : new Date(at).toISOString()

/** The tool of one turn: `ctx.principal` is read when the tool runs, so the status is the speaker's. */
export function presenceStatusSetToolOf(options: PresenceStatusToolOptions) {
  const clock = options.now ?? Date.now
  return (ctx: HarnessContext) =>
    tool({
      description: PRESENCE_STATUS_SET_DESCRIPTION,
      inputSchema: INPUT,
      metadata: { risk: 'write', reversible: true, source: 'trusted' },
      execute: async (input: z.infer<typeof INPUT>): Promise<PresenceStatusSetAnswer> => {
        const viewer = await options.actors.of(ctx.principal).catch(() => undefined)
        if (viewer === undefined) return { ok: false, reason: 'no status can be set here' }
        const now = clock()
        const from = input.from === undefined ? undefined : parseStatusTime(input.from, now)
        const until = input.until === undefined ? undefined : parseStatusTime(input.until, now)
        if (
          (input.from !== undefined && from === undefined) ||
          (input.until !== undefined && until === undefined)
        )
          return {
            ok: false,
            reason:
              'a time is an ISO time with a zone offset (2026-11-14T15:00:00+07:00) or minutes from now',
          }
        const clear = input.kind === 'clear'
        const set: PresenceStatusSet = clear
          ? { busy: false }
          : {
              busy: true,
              kind: input.kind as PresenceStatusKind,
              ...(input.note === undefined ? {} : { note: input.note }),
              ...(from === undefined ? {} : { from }),
              ...(until === undefined ? {} : { until }),
            }
        let view: PresenceStatusView
        const before = options.parietal.status?.(viewer.id)
        try {
          view = options.parietal.setStatus(viewer.id, set)
        } catch (error) {
          if (error instanceof ParietalError) return { ok: false, reason: error.message }
          return { ok: false, reason: 'the status could not be set' }
        }
        options.audit?.record({
          kind: 'presence.status.set',
          actor: viewer.id,
          via: 'local',
          detail: {
            subject: viewer.id,
            busy: set.busy,
            kind: clear ? null : (set.kind ?? 'busy'),
            minutes: null,
          },
        })
        if (before !== undefined)
          recordUndo(options.undo, ctx, {
            tool: PRESENCE_STATUS_SET_TOOL,
            summary: 'your status as it was',
            undo: () => {
              const restore: PresenceStatusSet =
                before.kind === null
                  ? { busy: false }
                  : {
                      busy: true,
                      kind: before.kind,
                      ...(before.note === null ? {} : { note: before.note }),
                      ...(before.from === null ? {} : { from: before.from }),
                      ...(before.until === null ? {} : { until: before.until }),
                    }
              try {
                options.parietal.setStatus(viewer.id, restore)
              } catch (error) {
                return {
                  ok: false,
                  reason: 'undo-failed',
                  message:
                    error instanceof ParietalError
                      ? error.message
                      : 'the status could not be restored',
                }
              }
              options.audit?.record({
                kind: 'presence.status.set',
                actor: viewer.id,
                via: 'local',
                detail: {
                  subject: viewer.id,
                  busy: restore.busy,
                  kind: before.kind,
                  minutes: null,
                },
              })
              return { ok: true, summary: 'your status is back as it was' }
            },
          })
        return clear
          ? { ok: true, status: 'cleared', from: null, until: null }
          : {
              ok: true,
              status: set.kind ?? 'busy',
              from: iso(view.from ?? from ?? now),
              until: iso(view.until),
            }
      },
    })
}

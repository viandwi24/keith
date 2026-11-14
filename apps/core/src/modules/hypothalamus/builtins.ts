// The built-in protocols of the self layer (docs/specs/hypothalamus.md, "Built-ins"): `approval-stale` pings the owner before an
// approval expires, `reminder-missed` tells a person a reminder that could not be delivered is here now. Seeded at boot as
// `keith`-owned protocols, idempotent by `(owner, built_in)`: a built-in that exists is never written again, so an owner's
// edits, pause or switch-off survive every boot. The definitions are checked by `authorDefinition` at seed time.
import {
  MS_HOUR,
  MS_MINUTE,
  type ProtocolDefinition,
  ProtocolDefinitionSchema,
  type Trigger,
} from '@keith/contracts'
import type { ProtocolsRepo } from '@keith/db'
import { authorDefinition, KEITH_OWNER } from './authoring.ts'

export const APPROVAL_STALE = 'approval-stale'
export const REMINDER_MISSED = 'reminder-missed'
// P29's succession protocol (`succession-shared.ts`, one constant): it is not seeded from `BUILT_IN_DEFINITIONS`, since its
// definition depends on the settings; `syncOwnerAbsence` (`builtins-succession.ts`) creates and versions it.
export { OWNER_ABSENCE } from './succession-shared.ts'
export type BuiltInName = typeof APPROVAL_STALE | typeof REMINDER_MISSED

/**
 * The seeded ping offset. It is the stored `until.beforeMs` of `approval-stale` and the default of the setting
 * `approvals.pingBeforeHours`; the engine never reads the stored value of this built-in (see `evaluatedTrigger`).
 */
export const APPROVAL_PING_BEFORE_MS = 2 * MS_HOUR

// the text names no hour: the ping offset is a setting (`approvals.pingBeforeHours`)
const APPROVAL_PING_TEXT = 'An approval waits and expires soon.'
const REMINDER_TEXT = 'A reminder could not be delivered earlier; here it is now.'

/**
 * The definitions as stored. `approval-stale` runs at `expiresAt - ping` of each approval (one run per approval, the ref is
 * `approval:<id>`; the ping is the live setting, see `evaluatedTrigger`); its guard reads the approval's current expiry, so
 * a moved expiry moves the ping and an answered approval ends the run `skipped`. `owner-of-run` on a keith-owned run is the instance owner. `reminder-missed` acts for the person of
 * the failed delivery: the run's person is that person (one run per failed delivery).
 */
export const BUILT_IN_DEFINITIONS: Record<BuiltInName, unknown> = {
  [APPROVAL_STALE]: {
    trigger: {
      kind: 'event',
      type: 'brain.amygdala.wait',
      until: { field: 'expiresAt', beforeMs: APPROVAL_PING_BEFORE_MS },
      guard: { kind: 'approval.pending' },
    },
    conditions: [],
    steps: [{ id: 'ping', kind: 'notify', to: 'owner-of-run', text: APPROVAL_PING_TEXT }],
    start: 'ping',
  },
  [REMINDER_MISSED]: {
    trigger: {
      kind: 'event',
      type: 'delivery.failed',
      filter: { source: 'plugin:reminders' },
    },
    conditions: [],
    steps: [
      { id: 'settle', kind: 'wait', durationMs: 15 * MS_MINUTE, next: 'tell' },
      {
        id: 'tell',
        kind: 'notify',
        to: 'owner-of-run',
        text: REMINDER_TEXT,
        branches: [{ when: 'failed', goto: 'retry-wait' }],
        next: 'end',
      },
      { id: 'retry-wait', kind: 'wait', durationMs: MS_HOUR, next: 'retry' },
      { id: 'retry', kind: 'notify', to: 'owner-of-run', text: REMINDER_TEXT, next: 'end' },
    ],
    start: 'settle',
  },
}

/**
 * The trigger as the engine evaluates it. The built-in `approval-stale` takes its ping offset from the live setting
 * (`approvals.pingBeforeHours`, read through `pingBeforeMs` each time it is needed), so the stored definition is never
 * rewritten and an owner's other edits to the built-in survive. Any other protocol, and a trigger without `until`, is
 * returned unchanged.
 */
export function evaluatedTrigger<T extends Trigger>(
  trigger: T,
  builtIn: string | null | undefined,
  pingBeforeMs: () => number,
): T {
  if (builtIn !== APPROVAL_STALE || trigger.kind !== 'event' || trigger.until === undefined) {
    return trigger
  }
  return { ...trigger, until: { ...trigger.until, beforeMs: pingBeforeMs() } }
}

export interface BuiltInSeedDeps {
  protocols: Pick<ProtocolsRepo, 'findBuiltIn' | 'create'>
  /** Epoch ms; a test passes a fixed clock. */
  now?: () => number
}

/** The `keith` caller of the seed: the owner role, with the chat capability authoring needs. */
const SEEDER = { id: 'system', role: 'owner', capabilities: new Set(['chat']) } as const

/**
 * Seeds the built-ins that are missing for the `keith` owner. Returns the names it created: an empty list on every boot
 * after the first (re-seed is a no-op). A definition that fails `authorDefinition` is a bug and throws.
 */
export function seedBuiltIns(deps: BuiltInSeedDeps): BuiltInName[] {
  const now = deps.now ?? Date.now
  // a seed is the system installing its own rules, not a person's act: it writes no audit row (an owner's edit of a built-in is audited by the service)
  const created: BuiltInName[] = []
  for (const name of Object.keys(BUILT_IN_DEFINITIONS) as BuiltInName[]) {
    if (deps.protocols.findBuiltIn(KEITH_OWNER, name) !== undefined) continue
    const at = now()
    const authored = authorDefinition({
      caller: SEEDER,
      owner: KEITH_OWNER,
      definition: BUILT_IN_DEFINITIONS[name],
      builtIn: name,
      caps: { maxSteps: 40, maxPerPerson: 0, ownedCount: 0 },
      now: at,
    })
    if (!authored.ok)
      throw new Error(`built-in ${name} is not a valid protocol: ${authored.message}`)
    const definition: ProtocolDefinition = ProtocolDefinitionSchema.parse(authored.definition)
    const row = deps.protocols.create(
      {
        id: Bun.randomUUIDv7(),
        owner: KEITH_OWNER,
        name,
        builtIn: name,
        definition: JSON.stringify(definition),
        savedBy: SEEDER.id,
      },
      at,
    )
    if (!row.ok) continue
    created.push(name)
  }
  return created
}

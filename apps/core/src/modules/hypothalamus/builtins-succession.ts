// The built-in `owner-absence` protocol (docs/specs/succession.md, "The protocol"). Its definition is generated from the
// succession settings: the window sets the check-in blocks, the heir sets the people it tells. `ownerAbsenceDefinition` is
// pure; `syncOwnerAbsence` is the one writer. It is idempotent: a second call with the same settings writes nothing, and
// a change of the window or the heir saves a new version (a running run keeps the version it started with).
import {
  type Condition,
  LimitsSchema,
  MAX_STEPS,
  MS_DAY,
  MS_HOUR,
  type ProtocolDefinition,
  ProtocolDefinitionSchema,
  type ProtocolStep,
  SUCCESSION_GRACE_DAYS,
  SUCCESSION_WINDOW_MAX_DAYS,
  SUCCESSION_WINDOW_MIN_DAYS,
} from '@keith/contracts'
import type { ProtocolsRepo } from '@keith/db'
import { authorDefinition, canonicalJson, KEITH_OWNER } from './authoring.ts'
import { OWNER_ABSENCE } from './succession-shared.ts'

/** Executions of one step per run (the contract's `maxVisits` default): a check-in block stays under it. */
export const CHECK_IN_VISIT_LIMIT = LimitsSchema.parse({}).maxVisits
/** A check-in block runs its ask at most this many times: one ask per day, a block per week. */
export const CHECK_IN_BLOCK_PASSES = 7
/**
 * The slack of a block's exit: the block ends at its last timeout, the exit test runs half a day later, so a late tick
 * can never move the exit onto the timeout before it.
 */
export const BLOCK_EXIT_SLACK_MS = 12 * MS_HOUR

/** The answer that ends the check-in: the owner is here. */
export const CHECK_IN_ANSWER = 'here'
/** Every run's executions stay under this (the contract's `maxSteps`). */
export const RUN_STEP_LIMIT = LimitsSchema.parse({}).maxSteps

// Fixed texts (ADR-0024: the engine never interpolates). The window is a number the builder writes into the text at
// generation time; the names of the people are resolved by the delivery layer from their ids.
/** The check-in text of every block after the first (the window is named once, in the first). */
const CHECK_IN_TEXT =
  'Keith has not heard from you for a while. Reply "I am here" or just use Keith.'
const OWNER_GRACE_TEXT = `Ownership will move to your heir after a ${SUCCESSION_GRACE_DAYS}-day grace period unless you use Keith. Any sign from you cancels it.`
const CLAIM_HEIR_TEXT = 'You may claim now: /succession claim'
const CLAIM_OWNER_TEXT =
  'The grace period is over. Your heir may claim ownership now. Use Keith to cancel it.'
const STOP_HEIR_TEXT = 'The owner is back; the succession protocol stopped.'
const STOP_OWNER_TEXT = 'The succession protocol stopped. You are back.'

const checkInText = (windowDays: number) =>
  `Keith has not heard from you for a while. Reply "I am here" or just use Keith. If you stay silent for ${windowDays} days, ownership can pass to your heir after a grace period.`
const heirGraceText = (windowDays: number) =>
  `The owner of this Keith has been silent for ${windowDays} days. A grace period of ${SUCCESSION_GRACE_DAYS} days started. If the owner does not return, you may claim ownership once it ends. Nothing happens before then.`

export interface OwnerAbsenceInput {
  /** The silence before the grace, 7 to 90 days (the setting `succession.windowDays`). */
  windowDays: number
  /** The owner's person id: the absence trigger and every check-in name them. */
  owner: string
  /** The heir's person id, or null while none is set (the protocol then stays disabled). */
  heir: string | null
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** A step before its `next` is linked: `link` fills the default `next` from the order of the list. */
type DraftStep = DistributiveOmit<ProtocolStep, 'next'> & { next?: string }
interface Draft {
  step: DraftStep
  /** Only with an heir: a step that tells the heir is left out while none is set. */
  heirOnly?: boolean
}

/** The silence (ms) the grace waits for: the window, less one hour of slack for the tick. */
const graceSilenceMs = (windowDays: number) => windowDays * MS_DAY - MS_HOUR

/** The check-in blocks a window needs: the asks run `windowDays - 1` times, `CHECK_IN_BLOCK_PASSES` per block. */
export const checkInBlocks = (windowDays: number) =>
  Math.ceil((windowDays - 1) / CHECK_IN_BLOCK_PASSES)

/**
 * The definition as stored. Shape (succession.md, "The protocol"):
 * - Check-in: one `ask` per day to the owner on every channel (its timeout is the day's wait). The asks sit in blocks of
 *   seven passes, `check-in-1` to `check-in-N`, each looping on itself. A block ends when the silence passes its last day:
 *   its timeout's condition branch goes on to the next block. The visit limit is never reached (7 per step).
 * - The grace begins at the first timeout where the owner has been silent for the whole window (`condition` branch, tested
 *   first). `I am here` ends the run. The pass count is `windowDays - 1`, generated into the blocks.
 * - Grace: `begin-grace` (system), the heir and the owner are told, a 7-day wait, then `open-claim` (system), the claim
 *   notices. `onCancel` is `stop`: the cancel (system) and the notices to both people.
 * The run stays under `RUN_STEP_LIMIT` executions for every window (a daily ask is one execution), see the tests.
 */
export function ownerAbsenceDefinition(input: OwnerAbsenceInput): ProtocolDefinition {
  const { windowDays, owner, heir } = input
  if (
    !Number.isInteger(windowDays) ||
    windowDays < SUCCESSION_WINDOW_MIN_DAYS ||
    windowDays > SUCCESSION_WINDOW_MAX_DAYS
  ) {
    throw new RangeError(
      `the succession window is ${SUCCESSION_WINDOW_MIN_DAYS} to ${SUCCESSION_WINDOW_MAX_DAYS} days, got ${windowDays}`,
    )
  }
  const silentFor = (ms: number): Condition => ({
    kind: 'not',
    of: { kind: 'signal.since', person: owner, ms },
  })
  // the heir-only steps name the owner as a placeholder: they are left out when there is no heir
  const toHeir = heir ?? owner
  const blocks = checkInBlocks(windowDays)

  const drafts: Draft[] = []
  for (let block = 1; block <= blocks; block++) {
    const id = `check-in-${block}`
    const branches: NonNullable<ProtocolStep['branches']> = [
      { when: 'condition', condition: silentFor(graceSilenceMs(windowDays)), goto: 'begin-grace' },
    ]
    // the block's last day is the timeout at (block * 7 + 1) days of silence: past its exit slack the next block starts
    if (block < blocks) {
      branches.push({
        when: 'condition',
        condition: silentFor(block * CHECK_IN_BLOCK_PASSES * MS_DAY + BLOCK_EXIT_SLACK_MS),
        goto: `check-in-${block + 1}`,
      })
    }
    branches.push({ when: `answer:${CHECK_IN_ANSWER}`, goto: 'end' })
    drafts.push({
      step: {
        id,
        kind: 'ask',
        to: owner,
        text: block === 1 ? checkInText(windowDays) : CHECK_IN_TEXT,
        options: [CHECK_IN_ANSWER],
        timeoutMs: MS_DAY,
        channels: 'all',
        next: id,
        branches,
      },
    })
  }
  drafts.push(
    { step: { id: 'begin-grace', kind: 'system', action: 'succession.begin-grace' } },
    {
      heirOnly: true,
      step: {
        id: 'grace-heir',
        kind: 'notify',
        to: toHeir,
        text: heirGraceText(windowDays),
        channels: 'all',
      },
    },
    {
      step: {
        id: 'grace-owner',
        kind: 'notify',
        to: owner,
        text: OWNER_GRACE_TEXT,
        channels: 'all',
      },
    },
    { step: { id: 'grace-wait', kind: 'wait', durationMs: SUCCESSION_GRACE_DAYS * MS_DAY } },
    { step: { id: 'open-claim', kind: 'system', action: 'succession.open-claim' } },
    {
      heirOnly: true,
      step: {
        id: 'claim-heir',
        kind: 'notify',
        to: toHeir,
        text: CLAIM_HEIR_TEXT,
        channels: 'all',
      },
    },
    {
      step: {
        id: 'claim-owner',
        kind: 'notify',
        to: owner,
        text: CLAIM_OWNER_TEXT,
        channels: 'all',
        next: 'end',
      },
    },
    // onCancel: the cancel runs once, then both people are told the protocol stopped
    { step: { id: 'stop', kind: 'system', action: 'succession.cancel' } },
    {
      heirOnly: true,
      step: { id: 'stop-heir', kind: 'notify', to: toHeir, text: STOP_HEIR_TEXT, channels: 'all' },
    },
    {
      step: {
        id: 'stop-owner',
        kind: 'notify',
        to: owner,
        text: STOP_OWNER_TEXT,
        channels: 'all',
        next: 'end',
      },
    },
  )

  const kept = drafts.filter((draft) => !draft.heirOnly || heir !== null)
  const steps = kept.map(
    (draft, index) =>
      ({
        ...draft.step,
        next: draft.step.next ?? kept[index + 1]?.step.id ?? 'end',
      }) as ProtocolStep,
  )

  return ProtocolDefinitionSchema.parse({
    trigger: { kind: 'absence', person: owner, afterMs: MS_DAY },
    conditions: [],
    steps,
    limits: {
      cancelWhen: { kind: 'signal.sinceRunStart', person: owner },
      onCancel: 'stop',
    },
    start: 'check-in-1',
  })
}

/** The heir and the window a stored or generated definition carries (read from its steps). */
export function describeOwnerAbsence(definition: ProtocolDefinition): {
  heir: string | null
  windowDays: number | null
} {
  const claim = definition.steps.find((step) => step.id === 'claim-heir')
  const heir = claim?.kind === 'notify' ? claim.to : null
  const ask = definition.steps.find((step) => step.kind === 'ask')
  const condition = ask?.branches?.find((branch) => branch.when === 'condition')?.condition
  const ms =
    condition?.kind === 'not' && condition.of.kind === 'signal.since' ? condition.of.ms : undefined
  return {
    heir,
    windowDays: ms === undefined ? null : Math.round((ms + MS_HOUR) / MS_DAY),
  }
}

/** The protocol is on exactly while there is an heir: every window 7 to 90 days is a valid ladder (`ownerAbsenceDefinition`). */
export function isEnabledWanted(described: { heir: string | null; windowDays: number | null }) {
  return described.heir !== null && described.windowDays !== null
}

export interface OwnerAbsenceSettings {
  owner: string
  windowDays: number
  heir: string | null
}

export type OwnerAbsenceProtocols = Pick<
  ProtocolsRepo,
  'findBuiltIn' | 'create' | 'version' | 'saveVersion' | 'setEnabled'
>

export interface OwnerAbsenceSyncInput {
  protocols: OwnerAbsenceProtocols
  settings: OwnerAbsenceSettings
  /** Epoch ms, stored as the version's `savedAt`. */
  now: number
}

export interface OwnerAbsenceSync {
  /**
   * `created`: the protocol was seeded. `versioned`: a new version was saved (the window or the heir changed).
   * `unchanged`: nothing was written. `conflict`: the stored version moved under the call; nothing was saved, the next
   * sync retries. A name clash with a protocol of the owner's own is also `conflict` (version 0).
   */
  action: 'created' | 'versioned' | 'unchanged' | 'conflict'
  version: number
  /** The enabled flag after the call (on exactly while there is an heir, unless a conflict kept the old one). */
  enabled: boolean
}

const SYSTEM_CALLER = { id: 'system', role: 'owner', capabilities: new Set(['chat']) } as const

/**
 * Makes the stored `owner-absence` protocol match the settings. The enabled flag is set on every call: on while there is an
 * heir, off without one. Nobody else can switch it (the protocol service refuses it, `service.ts`). A changed definition is
 * saved as a new version (CAS on the current version). Disable goes before the version save and enable after it, so a
 * crash leaves the next sync to finish the writes.
 */
export function syncOwnerAbsence({
  protocols,
  settings,
  now,
}: OwnerAbsenceSyncInput): OwnerAbsenceSync {
  const definition = ownerAbsenceDefinition(settings)
  const wanted = isEnabledWanted(describeOwnerAbsence(definition))
  const existing = protocols.findBuiltIn(KEITH_OWNER, OWNER_ABSENCE)

  if (existing === undefined) {
    const authored = authorDefinition({
      caller: SYSTEM_CALLER,
      owner: KEITH_OWNER,
      definition,
      builtIn: OWNER_ABSENCE,
      caps: { maxSteps: MAX_STEPS, maxPerPerson: 0, ownedCount: 0 },
      now,
    })
    if (!authored.ok) throw new Error(`owner-absence is not a valid protocol: ${authored.message}`)
    const created = protocols.create(
      {
        id: Bun.randomUUIDv7(),
        owner: KEITH_OWNER,
        name: OWNER_ABSENCE,
        builtIn: OWNER_ABSENCE,
        enabled: wanted,
        definition: JSON.stringify(authored.definition),
        savedBy: SYSTEM_CALLER.id,
      },
      now,
    )
    if (!created.ok) return { action: 'conflict', version: 0, enabled: false }
    return { action: 'created', version: created.protocol.version, enabled: wanted }
  }

  const stored = protocols.version(existing.id, existing.version)
  const storedParsed =
    stored === undefined
      ? undefined
      : ProtocolDefinitionSchema.safeParse(JSON.parse(stored.definition))
  const previous = storedParsed?.success ? storedParsed.data : undefined
  const changed = previous === undefined || canonicalJson(previous) !== canonicalJson(definition)

  if (!wanted && existing.enabled) protocols.setEnabled(existing.id, false, now)
  if (!changed) {
    if (wanted && !existing.enabled) protocols.setEnabled(existing.id, true, now)
    return { action: 'unchanged', version: existing.version, enabled: wanted }
  }

  const authored = authorDefinition({
    caller: SYSTEM_CALLER,
    owner: KEITH_OWNER,
    definition,
    builtIn: OWNER_ABSENCE,
    existing: { owner: KEITH_OWNER, approvals: [] },
    caps: { maxSteps: MAX_STEPS, maxPerPerson: 0, ownedCount: 0 },
    now,
  })
  if (!authored.ok) throw new Error(`owner-absence is not a valid protocol: ${authored.message}`)
  const saved = protocols.saveVersion(
    existing.id,
    existing.version,
    { definition: JSON.stringify(authored.definition), approvals: '[]', savedBy: SYSTEM_CALLER.id },
    now,
  )
  if (!saved.ok) {
    return {
      action: 'conflict',
      version: existing.version,
      enabled: wanted ? existing.enabled : false,
    }
  }

  if (wanted && !existing.enabled) protocols.setEnabled(existing.id, true, now)
  return { action: 'versioned', version: saved.version, enabled: wanted }
}

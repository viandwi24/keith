// The built-in `dream` protocol, one per person (docs/specs/dreaming.md, "Scheduling"; ADR-0031 §6). Its definition is generated from
// the person's mode and the `dreaming.maxUsdPerRun` setting. `dreamDefinition` is pure; `syncDream` is the one writer. Like
// `syncOwnerAbsence` it is idempotent: a second call with the same inputs writes nothing. `off` disables the protocol and never
// deletes it, so its run history stays readable.
import {
  DREAM_SETTING_KEYS,
  DREAMING_SETTINGS_DEFAULTS,
  type DreamMemberDefault,
  type DreamMode,
  MAX_STEPS,
  MS_MINUTE,
  type ProtocolDefinition,
  ProtocolDefinitionSchema,
} from '@keith/contracts'
import type { ProtocolsRepo, SettingsRepo } from '@keith/db'
import { authorDefinition, canonicalJson } from './authoring.ts'

/** The built-in name and the protocol name of the dreaming pass (one per owner, `(owner, built_in)` unique). */
export const DREAM = 'dream' as const
/** The schedule: 03:00 in the core host's zone (dreaming.md, rule 10). */
export const DREAM_CRON = '0 3 * * *'
/** The person must have been silent for this long: a run never starts while they are talking to Keith. */
export const DREAM_IDLE_MS = 30 * MS_MINUTE
/** The id of the one step of the protocol. */
export const DREAM_STEP = 'dream-run'

/** The system action the one step runs (`steps.ts` `system`, `dream-steps.ts`). */
const DREAM_ACTION = 'dreaming.run'

/** What the built-in is generated from: the person it belongs to and the cap of one run. */
export interface DreamDefinitionInput {
  personId: string
  /** `dreaming.maxUsdPerRun`: the judge turn's cap, also the budget the condition checks before a start. */
  maxUsdPerRun: number
}

/**
 * The definition as stored. One system step (`dreaming.run`), started by the cron, and two conditions: the person is idle for
 * `DREAM_IDLE_MS` (`not(signal.since)`, the person's own sign only) and the person's budget covers one run.
 */
export function dreamDefinition({
  personId,
  maxUsdPerRun,
}: DreamDefinitionInput): ProtocolDefinition {
  return ProtocolDefinitionSchema.parse({
    trigger: { kind: 'time', cron: DREAM_CRON },
    conditions: [
      { kind: 'not', of: { kind: 'signal.since', person: personId, ms: DREAM_IDLE_MS } },
      { kind: 'budget.remaining', person: personId, usdAtLeast: maxUsdPerRun },
    ],
    steps: [{ id: DREAM_STEP, kind: 'system', action: DREAM_ACTION, next: 'end' }],
    start: DREAM_STEP,
  })
}

/** The mode a person has when nothing is stored (dreaming.md, Rule 5): the owner `propose`, a member the member default. */
export function effectiveDreamMode(input: {
  stored: DreamMode | undefined
  owner: boolean
  memberDefault: DreamMemberDefault
}): DreamMode {
  if (input.stored !== undefined) return input.stored
  return input.owner ? 'propose' : input.memberDefault
}

/** The dreaming settings in force: the stored values, or the defaults when nothing is stored. */
export function dreamSettingsOf(settings: Pick<SettingsRepo, 'get'>): {
  maxUsdPerRun: number
  memberDefault: DreamMemberDefault
} {
  return {
    maxUsdPerRun:
      settings.get<number>(DREAM_SETTING_KEYS.maxUsdPerRun) ??
      DREAMING_SETTINGS_DEFAULTS.maxUsdPerRun,
    memberDefault:
      settings.get<DreamMemberDefault>(DREAM_SETTING_KEYS.memberDefault) ??
      DREAMING_SETTINGS_DEFAULTS.memberDefault,
  }
}

export type DreamProtocols = Pick<
  ProtocolsRepo,
  'findBuiltIn' | 'create' | 'version' | 'saveVersion' | 'setEnabled'
>

export interface SyncDreamInput {
  protocols: DreamProtocols
  personId: string
  mode: DreamMode
  maxUsdPerRun: number
  /** Epoch ms, stored as the version's `savedAt`. */
  now: number
}

export interface SyncDream {
  /**
   * `created`: the protocol was seeded for the person. `versioned`: a new version was saved (the cap changed). `enabled` and
   * `disabled`: only the flag moved. `unchanged`: nothing was written. `conflict`: a name clash, or the stored version moved
   * under the call; nothing was saved and the next sync retries.
   */
  action: 'created' | 'versioned' | 'enabled' | 'disabled' | 'unchanged' | 'conflict'
  enabled: boolean
}

const SYSTEM_CALLER = { id: 'system', role: 'owner', capabilities: new Set(['chat']) } as const

/**
 * Makes the person's `dream` protocol match the mode and the cap. Mode `off` disables it (never deletes) and writes nothing when
 * there is none. Any other mode creates it enabled, or saves a version when the cap changed, and enables it. Disable goes before
 * the version save and enable after it, as in `syncOwnerAbsence`.
 */
export function syncDream({
  protocols,
  personId,
  mode,
  maxUsdPerRun,
  now,
}: SyncDreamInput): SyncDream {
  const existing = protocols.findBuiltIn(personId, DREAM)
  const wanted = mode !== 'off'

  if (!wanted) {
    if (existing === undefined || !existing.enabled) return { action: 'unchanged', enabled: false }
    protocols.setEnabled(existing.id, false, now)
    return { action: 'disabled', enabled: false }
  }

  const definition = dreamDefinition({ personId, maxUsdPerRun })
  const authorInput = {
    caller: SYSTEM_CALLER,
    owner: personId,
    definition,
    builtIn: DREAM,
    caps: { maxSteps: MAX_STEPS, maxPerPerson: 1, ownedCount: 0 },
    now,
  }

  if (existing === undefined) {
    const authored = authorDefinition(authorInput)
    if (!authored.ok) throw new Error(`dream is not a valid protocol: ${authored.message}`)
    const created = protocols.create(
      {
        id: Bun.randomUUIDv7(),
        owner: personId,
        name: DREAM,
        builtIn: DREAM,
        enabled: true,
        definition: JSON.stringify(authored.definition),
        savedBy: SYSTEM_CALLER.id,
      },
      now,
    )
    return created.ok
      ? { action: 'created', enabled: true }
      : { action: 'conflict', enabled: false }
  }

  const stored = protocols.version(existing.id, existing.version)
  const storedParsed =
    stored === undefined
      ? undefined
      : ProtocolDefinitionSchema.safeParse(JSON.parse(stored.definition))
  const previous = storedParsed?.success ? storedParsed.data : undefined
  const changed = previous === undefined || canonicalJson(previous) !== canonicalJson(definition)

  if (!changed) {
    if (existing.enabled) return { action: 'unchanged', enabled: true }
    protocols.setEnabled(existing.id, true, now)
    return { action: 'enabled', enabled: true }
  }

  const authored = authorDefinition({
    ...authorInput,
    existing: { owner: personId, approvals: [] },
  })
  if (!authored.ok) throw new Error(`dream is not a valid protocol: ${authored.message}`)
  const saved = protocols.saveVersion(
    existing.id,
    existing.version,
    { definition: JSON.stringify(authored.definition), approvals: '[]', savedBy: SYSTEM_CALLER.id },
    now,
  )
  if (!saved.ok) return { action: 'conflict', enabled: existing.enabled }
  if (!existing.enabled) protocols.setEnabled(existing.id, true, now)
  return { action: 'versioned', enabled: true }
}

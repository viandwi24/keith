// Authoring of protocols (docs/specs/hypothalamus.md, "Authoring"). One pure function decides who may save which step.
// RPC, CLI, agent tools and proposal confirmation all call it; it reads no store and no clock (the caller passes `now`).
import {
  type ActOperation,
  BRAIN_EVENT_TYPES,
  type Condition,
  type Filter,
  type PersonRole,
  ProposalDefinitionSchema,
  type ProtocolBuiltIn,
  type ProtocolDefinition,
  ProtocolDefinitionSchema,
  type Recipient,
} from '@keith/contracts'

/** The owner of a `keith`-owned protocol: the self layer (ADR-0020), never a person. */
export const KEITH_OWNER = 'keith'

/** Person caps (docs/specs/hypothalamus.md, "Authoring"): a member may not exceed them; the owner role may. */
export const PERSON_MAX_RUNS_PER_DAY = 5
export const PERSON_MAX_BUDGET_USD_PER_RUN = 0.05

/** Events a trigger may name: the brain events of the feed and the P25 delivery record. */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...BRAIN_EVENT_TYPES,
  'delivery.failed',
])

/**
 * An `act` operation whose name says it changes ownership, a grant or a secret is refused for every author. Only the
 * built-in succession protocol (P29) may call `transferOwner`, through its own coded path (ADR-0022 §2).
 */
const FORBIDDEN_OPERATION =
  /transfer|owner|grant|secret|token|passw|credential|role|permission|capabilit/i

/** The pre-approval of one `act` step: the hash of its exact operation and input, who approved it and when. */
export interface ActApproval {
  step: string
  hash: string
  approvedBy: string
  approvedAt: number
}

export interface AuthorCaller {
  id: string
  role: PersonRole
  /** The capabilities the caller holds (`capabilitiesOf(role, grants)`); authoring needs `chat`. */
  capabilities: ReadonlySet<string>
}

export interface AuthorCaps {
  /** Steps one definition may hold (at most the contract's MAX_STEPS). */
  maxSteps: number
  /** Protocols one person may own (`protocols.maxPerPerson`, read from settings by the caller). */
  maxPerPerson: number
  /** Protocols the owner already holds; checked only when this call creates one. */
  ownedCount: number
}

export interface AuthorInput {
  caller: AuthorCaller
  /** `keith` or a person id. Never changed by a save (ownership is fixed at creation). */
  owner: string
  /** The raw definition as the surface sent it; validated here, never trusted. */
  definition: unknown
  /** A proposal (`protocol_proposals`) is held to the stricter proposal schema. Default `protocol`. */
  source?: 'protocol' | 'proposal'
  /** The built-in (`builtins.ts`) this definition is seeded as: the owner role only, and the only holder of `system` steps. */
  builtIn?: ProtocolBuiltIn
  /** `true` records the pre-approval of every `act` step; the owner role only. */
  approve?: boolean
  /** The stored protocol when this is a new version: its owner and the approvals already on record. */
  existing?: { owner: string; approvals: readonly ActApproval[] }
  caps: AuthorCaps
  /** Epoch ms, stored as `approvedAt`. */
  now: number
}

export type AuthorRefusalReason =
  | 'author-rule'
  | 'invalid'
  | 'needs-approval'
  | 'unknown-event'
  | 'cap'

export interface AuthorRefusal {
  ok: false
  reason: AuthorRefusalReason
  /** Where the refusal sits in the definition (`steps.2.kind`), or `''` for the whole call. */
  path: string
  message: string
}

export type AuthorResult =
  | { ok: true; definition: ProtocolDefinition; approvals: ActApproval[] }
  | AuthorRefusal

/**
 * Hash of an `act` step's exact operation and input (canonical JSON, SHA-256). The pre-approval is this hash: a changed
 * operation or input is a different hash and needs a new approval (ADR-0024 §3).
 */
export function actApprovalHash(operation: ActOperation, input: unknown): string {
  return new Bun.CryptoHasher('sha256').update(canonicalJson({ operation, input })).digest('hex')
}

/** JSON with sorted object keys and no undefined members, so equal values hash equal. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
  return `{${members.join(',')}}`
}

/** Decides whether `caller` may save `definition` for `owner`. Returns the parsed definition or the first refusal. */
export function authorDefinition(input: AuthorInput): AuthorResult {
  const { caller, owner } = input
  const ownerRole = caller.role === 'owner'

  if (!caller.capabilities.has('chat')) {
    return refuse('author-rule', '', 'the caller may not chat, so may not author a protocol')
  }
  if (owner === KEITH_OWNER && !ownerRole) {
    return refuse('author-rule', 'owner', 'only the owner authors a keith-owned protocol')
  }
  if (owner !== KEITH_OWNER && owner !== caller.id && !ownerRole) {
    return refuse('author-rule', 'owner', 'a person authors only their own protocols')
  }
  if (input.builtIn !== undefined && !ownerRole) {
    return refuse('author-rule', 'owner', 'built-in protocols belong to the owner role')
  }
  if (input.existing !== undefined && input.existing.owner !== owner) {
    return refuse('author-rule', 'owner', 'a protocol never changes owner')
  }
  if (input.source === 'proposal' && owner === KEITH_OWNER) {
    return refuse('author-rule', 'owner', 'a proposal belongs to a person')
  }

  const parsed =
    input.source === 'proposal'
      ? ProposalDefinitionSchema.safeParse(input.definition)
      : ProtocolDefinitionSchema.safeParse(input.definition)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return refuse('invalid', pathOf(issue?.path ?? []), issue?.message ?? 'invalid definition')
  }
  const definition: ProtocolDefinition = parsed.data

  const rule = checkRules(definition, {
    caller,
    owner,
    ownerRole,
    eventTriggered: definition.trigger.kind === 'event',
    builtIn: input.builtIn,
  })
  if (rule !== undefined) return rule

  if (definition.steps.length > input.caps.maxSteps) {
    return refuse('cap', 'steps', `a protocol holds at most ${input.caps.maxSteps} steps`)
  }
  if (!ownerRole) {
    if (definition.limits.maxRunsPerDay > PERSON_MAX_RUNS_PER_DAY) {
      return refuse(
        'cap',
        'limits.maxRunsPerDay',
        `a person may run a protocol ${PERSON_MAX_RUNS_PER_DAY} times a day`,
      )
    }
    if (definition.limits.budgetUsdPerRun > PERSON_MAX_BUDGET_USD_PER_RUN) {
      return refuse(
        'cap',
        'limits.budgetUsdPerRun',
        `a person's run budget is at most ${PERSON_MAX_BUDGET_USD_PER_RUN} USD`,
      )
    }
  }
  if (
    input.existing === undefined &&
    owner !== KEITH_OWNER &&
    input.caps.ownedCount >= input.caps.maxPerPerson
  ) {
    return refuse('cap', '', `a person may own at most ${input.caps.maxPerPerson} protocols`)
  }

  return approvalsFor(definition, input)
}

interface RuleContext {
  caller: AuthorCaller
  owner: string
  ownerRole: boolean
  /** The trigger is an event: a keith-owned run then takes its person from the event (`owner-of-run`). */
  eventTriggered: boolean
  /** The built-in this definition is seeded as, if any: only `owner-absence` and `dream` may hold a `system` step. */
  builtIn: ProtocolBuiltIn | undefined
}

/**
 * The system actions a built-in may hold (docs/specs/hypothalamus.md, "Authoring"): `owner-absence` the succession actions,
 * `dream` the one dreaming action. Nothing else holds a system step.
 */
function systemStepAllowed(builtIn: ProtocolBuiltIn | undefined, action: string): boolean {
  if (builtIn === 'owner-absence') return action.startsWith('succession.')
  if (builtIn === 'dream') return action === 'dreaming.run'
  return false
}

/** Who may author which step, trigger, condition and recipient. The first refusal wins. */
function checkRules(definition: ProtocolDefinition, ctx: RuleContext): AuthorRefusal | undefined {
  const { trigger } = definition
  const triggerRefusal = checkTrigger(trigger, ctx)
  if (triggerRefusal !== undefined) return triggerRefusal

  for (const [index, condition] of definition.conditions.entries()) {
    const refusal = checkCondition(condition, `conditions.${index}`, ctx)
    if (refusal !== undefined) return refusal
  }
  if (definition.limits.cancelWhen !== undefined) {
    const refusal = checkCondition(definition.limits.cancelWhen, 'limits.cancelWhen', ctx)
    if (refusal !== undefined) return refusal
  }

  for (const [index, step] of definition.steps.entries()) {
    const at = `steps.${index}`
    // a system step is coded, not authored: owner-absence holds the succession actions, dream holds `dreaming.run` only
    if (step.kind === 'system' && !systemStepAllowed(ctx.builtIn, step.action)) {
      return refuse(
        'author-rule',
        `${at}.kind`,
        'only a built-in protocol holds a system step, and only the action it owns',
      )
    }
    if (step.kind === 'act') {
      if (!ctx.ownerRole)
        return refuse('author-rule', `${at}.kind`, 'only the owner adds an act step')
      const names =
        step.operation.kind === 'node.capability'
          ? [step.operation.capability]
          : [step.operation.plugin, step.operation.operation]
      if (names.some((name) => FORBIDDEN_OPERATION.test(name))) {
        return refuse(
          'author-rule',
          `${at}.operation`,
          'an act never changes ownership, a grant or a secret',
        )
      }
    }
    if (step.kind === 'notify' || step.kind === 'ask' || step.kind === 'wake') {
      const refusal = checkRecipient(step.to, `${at}.to`, ctx)
      if (refusal !== undefined) return refusal
    }
    if (
      (step.kind === 'notify' || step.kind === 'wake') &&
      step.urgent === true &&
      !ctx.ownerRole
    ) {
      return refuse('author-rule', `${at}.urgent`, 'only the owner sets urgent')
    }
    for (const [b, branch] of (step.branches ?? []).entries()) {
      if (branch.condition !== undefined) {
        const refusal = checkCondition(branch.condition, `${at}.branches.${b}.condition`, ctx)
        if (refusal !== undefined) return refusal
      }
    }
  }
  return undefined
}

function checkTrigger(
  trigger: ProtocolDefinition['trigger'],
  ctx: RuleContext,
): AuthorRefusal | undefined {
  switch (trigger.kind) {
    case 'time':
      return undefined
    case 'absence':
      if (!ctx.ownerRole && trigger.person !== ctx.caller.id) {
        return refuse('author-rule', 'trigger.person', 'a member watches only their own absence')
      }
      return undefined
    case 'signal':
      return checkFilterPerson(trigger.filter, 'trigger.filter', ctx)
    case 'event': {
      if (!KNOWN_EVENT_TYPES.has(trigger.type)) {
        return refuse(
          'unknown-event',
          'trigger.type',
          `"${trigger.type}" is not an event of the feed`,
        )
      }
      if (!ctx.ownerRole && trigger.filter?.personId !== ctx.owner) {
        return refuse(
          'author-rule',
          'trigger.filter.personId',
          'a member names their own personId in an event trigger',
        )
      }
      if (trigger.guard !== undefined) return checkCondition(trigger.guard, 'trigger.guard', ctx)
      return undefined
    }
  }
}

/** A signal or event filter that names a person must name the protocol's owner (a member's own). */
function checkFilterPerson(
  filter: Filter | undefined,
  path: string,
  ctx: RuleContext,
): AuthorRefusal | undefined {
  if (ctx.ownerRole || filter === undefined) return undefined
  for (const key of ['person', 'personId']) {
    if (key in filter && filter[key] !== ctx.owner) {
      return refuse('author-rule', `${path}.${key}`, 'a member sees only their own signals')
    }
  }
  return undefined
}

function checkRecipient(to: Recipient, path: string, ctx: RuleContext): AuthorRefusal | undefined {
  if (to === 'owner-of-run') {
    // a keith-owned protocol has no implicit person: each step names one, or the event names it (docs/specs/hypothalamus.md, "Principal and rights")
    if (ctx.owner === KEITH_OWNER && !ctx.eventTriggered)
      return refuse(
        'invalid',
        path,
        'a keith-owned protocol names the person of each step or reacts to an event',
      )
    return undefined
  }
  if (to === ctx.owner || ctx.owner === KEITH_OWNER) return undefined
  // a person-owned protocol may message only its owner; a keith-owned one may name any person (its owner-only gate
  // above already holds)
  return refuse('author-rule', path, 'a person-owned protocol may notify only its owner')
}

function checkCondition(
  condition: Condition,
  path: string,
  ctx: RuleContext,
): AuthorRefusal | undefined {
  switch (condition.kind) {
    case 'all':
    case 'any':
      for (const [index, item] of condition.of.entries()) {
        const refusal = checkCondition(item, `${path}.of.${index}`, ctx)
        if (refusal !== undefined) return refusal
      }
      return undefined
    case 'not':
      return checkCondition(condition.of, `${path}.of`, ctx)
    case 'time.between':
      return undefined
    case 'presence':
    case 'agenda.busy':
    case 'signal.since':
    case 'signal.sinceRunStart':
    case 'budget.remaining':
      if (!ctx.ownerRole && condition.person !== ctx.owner) {
        return refuse(
          'author-rule',
          `${path}.person`,
          'a member reads only their own state in a condition',
        )
      }
      return undefined
    case 'approval.pending':
      if (!ctx.ownerRole)
        return refuse(
          'author-rule',
          `${path}.approvalId`,
          'only the owner reads approvals in a condition',
        )
      return undefined
  }
}

/** Every `act` step needs the stored pre-approval of its exact operation and input, or an owner approval now. */
function approvalsFor(definition: ProtocolDefinition, input: AuthorInput): AuthorResult {
  const approvals: ActApproval[] = []
  for (const [index, step] of definition.steps.entries()) {
    if (step.kind !== 'act') continue
    const hash = actApprovalHash(step.operation, step.input)
    const recorded = input.existing?.approvals.find(
      (item) => item.step === step.id && item.hash === hash,
    )
    if (recorded !== undefined) {
      approvals.push(recorded)
    } else if (input.approve === true && input.caller.role === 'owner') {
      approvals.push({ step: step.id, hash, approvedBy: input.caller.id, approvedAt: input.now })
    } else {
      return refuse(
        'needs-approval',
        `steps.${index}.input`,
        `act step "${step.id}" needs the owner's approval of this exact input`,
      )
    }
  }
  return { ok: true, definition, approvals }
}

function refuse(reason: AuthorRefusalReason, path: string, message: string): AuthorRefusal {
  return { ok: false, reason, path, message }
}

function pathOf(path: readonly PropertyKey[]): string {
  return path.map(String).join('.')
}

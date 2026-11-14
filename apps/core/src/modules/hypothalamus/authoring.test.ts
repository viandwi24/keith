import { describe, expect, test } from 'bun:test'
import type { AuthorCaller, AuthorInput, AuthorResult } from './authoring.ts'
import { actApprovalHash, authorDefinition, canonicalJson, KEITH_OWNER } from './authoring.ts'

// The authoring rules (docs/specs/hypothalamus.md, "Authoring"): who may author which step, the caps, the approval of
// an `act`, and the proposal schema. Table-driven; the function is pure, so no store or clock is faked.

const NOW = 1_900_000_000_000
const ALL_CAPS = ['chat', 'tasks.own', 'settings.read', 'audit.read']
const vian: AuthorCaller = { id: 'vian', role: 'owner', capabilities: new Set(ALL_CAPS) }
const ana: AuthorCaller = { id: 'ana', role: 'member', capabilities: new Set(['chat']) }
const CAPS = { maxSteps: 40, maxPerPerson: 20, ownedCount: 0 }

const notify = (to: string = 'owner-of-run') => ({
  id: 'tell',
  kind: 'notify',
  to,
  text: 'Time to stretch.',
})
const wait = { id: 'pause', kind: 'wait', durationMs: 60_000 * 60 }
const act = (input: unknown = { level: 1 }) => ({
  id: 'run-check',
  kind: 'act',
  operation: { kind: 'node.capability', node: 'laptop', capability: 'system.info' },
  input,
})
const ladder = (...steps: unknown[]) => ({
  trigger: { kind: 'time', at: NOW + 60_000 },
  steps,
  start: (steps[0] as { id: string }).id,
})

function author(overrides: Partial<AuthorInput> & { definition: unknown }): AuthorResult {
  return authorDefinition({ caller: ana, owner: 'ana', caps: CAPS, now: NOW, ...overrides })
}

function expectRefused(result: AuthorResult, reason: string, path?: string): void {
  if (result.ok) throw new Error('expected a refusal, got an accepted definition')
  expect(result.reason).toBe(reason as never)
  if (path !== undefined) expect(result.path).toBe(path)
}

describe('who may author which step', () => {
  test('a member notifies, asks, wakes and waits for themselves', () => {
    const definition = ladder(
      notify(),
      { id: 'ask', kind: 'ask', to: 'ana', text: 'Still there?', timeoutMs: 3_600_000 },
      { id: 'wake', kind: 'wake', to: 'ana', instruction: 'Check in on the day.' },
      wait,
    )
    expect(author({ definition }).ok).toBe(true)
  })

  test('a member with an act step is refused', () => {
    expectRefused(author({ definition: ladder(act()) }), 'author-rule', 'steps.0.kind')
  })

  test('the owner role still needs an approval for an act step, even a read one', () => {
    expectRefused(
      authorDefinition({
        caller: vian,
        owner: 'vian',
        definition: ladder(act()),
        caps: CAPS,
        now: NOW,
      }),
      'needs-approval',
      'steps.0.input',
    )
  })

  test('a member notifies another person: refused', () => {
    expectRefused(author({ definition: ladder(notify('vian')) }), 'author-rule', 'steps.0.to')
  })

  test('a member wakes another person by naming them: refused', () => {
    const wake = { id: 'w', kind: 'wake', to: 'bob', instruction: 'Hello.' }
    expectRefused(author({ definition: ladder(wake) }), 'author-rule', 'steps.0.to')
  })

  test('a member sets urgent: refused; the owner role may', () => {
    const urgent = { ...notify(), urgent: true }
    expectRefused(author({ definition: ladder(urgent) }), 'author-rule', 'steps.0.urgent')
    expect(
      authorDefinition({
        caller: vian,
        owner: 'vian',
        definition: ladder(urgent),
        caps: CAPS,
        now: NOW,
      }).ok,
    ).toBe(true)
  })

  test('the owner role may notify another person in a keith-owned protocol only', () => {
    const toBob = ladder(notify('bob'))
    expect(
      authorDefinition({
        caller: vian,
        owner: KEITH_OWNER,
        definition: toBob,
        caps: CAPS,
        now: NOW,
      }).ok,
    ).toBe(true)
    expectRefused(
      authorDefinition({ caller: vian, owner: 'ana', definition: toBob, caps: CAPS, now: NOW }),
      'author-rule',
      'steps.0.to',
    )
  })

  test('a keith-owned protocol names the person of each step; owner-of-run is refused', () => {
    expectRefused(
      authorDefinition({
        caller: vian,
        owner: KEITH_OWNER,
        definition: ladder(notify()),
        caps: CAPS,
        now: NOW,
      }),
      'invalid',
      'steps.0.to',
    )
  })

  test('a member may not author a keith-owned protocol', () => {
    expectRefused(
      authorDefinition({
        caller: ana,
        owner: KEITH_OWNER,
        definition: ladder(notify('ana')),
        caps: CAPS,
        now: NOW,
      }),
      'author-rule',
      'owner',
    )
  })

  test('a member authors only for themselves', () => {
    expectRefused(
      authorDefinition({
        caller: ana,
        owner: 'vian',
        definition: ladder(notify('vian')),
        caps: CAPS,
        now: NOW,
      }),
      'author-rule',
      'owner',
    )
  })

  test('a caller without chat is refused', () => {
    const silent: AuthorCaller = { id: 'ana', role: 'member', capabilities: new Set() }
    expectRefused(
      authorDefinition({
        caller: silent,
        owner: 'ana',
        definition: ladder(notify()),
        caps: CAPS,
        now: NOW,
      }),
      'author-rule',
    )
  })

  test('built-ins are the owner role only', () => {
    expectRefused(
      author({ definition: ladder(notify()), builtIn: 'reminder-missed' }),
      'author-rule',
      'owner',
    )
  })

  test('a protocol never changes owner', () => {
    expectRefused(
      authorDefinition({
        caller: vian,
        owner: 'vian',
        definition: ladder(notify('vian')),
        existing: { owner: 'ana', approvals: [] },
        caps: CAPS,
        now: NOW,
      }),
      'author-rule',
      'owner',
    )
  })
})

describe('triggers and conditions', () => {
  test('a member watches only their own absence', () => {
    const trigger = (person: string) => ({ kind: 'absence', person, afterMs: 3_600_000 })
    expect(author({ definition: { ...ladder(notify()), trigger: trigger('ana') } }).ok).toBe(true)
    expectRefused(
      author({ definition: { ...ladder(notify()), trigger: trigger('vian') } }),
      'author-rule',
      'trigger.person',
    )
  })

  test('an unknown event type is refused as unknown-event', () => {
    const trigger = { kind: 'event', type: 'brain.nowhere.start' }
    expectRefused(
      author({ definition: { ...ladder(notify()), trigger } }),
      'unknown-event',
      'trigger.type',
    )
  })

  test('a member event trigger names their own personId', () => {
    const base = { kind: 'event', type: 'delivery.failed' }
    expectRefused(
      author({ definition: { ...ladder(notify()), trigger: base } }),
      'author-rule',
      'trigger.filter.personId',
    )
    expectRefused(
      author({
        definition: { ...ladder(notify()), trigger: { ...base, filter: { personId: 'vian' } } },
      }),
      'author-rule',
      'trigger.filter.personId',
    )
    const own = { ...base, filter: { personId: 'ana' } }
    expect(author({ definition: { ...ladder(notify()), trigger: own } }).ok).toBe(true)
  })

  test("a member condition about another person is refused; approvals are the owner's", () => {
    const withCondition = (condition: unknown) => ({ ...ladder(notify()), conditions: [condition] })
    expectRefused(
      author({ definition: withCondition({ kind: 'presence', person: 'vian', in: ['busy'] }) }),
      'author-rule',
      'conditions.0.person',
    )
    expectRefused(
      author({
        definition: withCondition({
          kind: 'all',
          of: [
            { kind: 'time.between', from: '09:00', to: '10:00' },
            { kind: 'agenda.busy', person: 'vian' },
          ],
        }),
      }),
      'author-rule',
      'conditions.0.of.1.person',
    )
    expectRefused(
      author({ definition: withCondition({ kind: 'approval.pending', approvalId: 'a1' }) }),
      'author-rule',
      'conditions.0.approvalId',
    )
    expect(
      author({ definition: withCondition({ kind: 'signal.since', person: 'ana', ms: 3_600_000 }) })
        .ok,
    ).toBe(true)
  })

  test('the owner role may cancel over another person', () => {
    const definition = {
      ...ladder(notify('bob')),
      limits: { cancelWhen: { kind: 'signal.since', person: 'bob', ms: 3_600_000 } },
    }
    expect(
      authorDefinition({ caller: vian, owner: KEITH_OWNER, definition, caps: CAPS, now: NOW }).ok,
    ).toBe(true)
  })
})

describe('act and its pre-approval', () => {
  const operation = { kind: 'node.capability', node: 'laptop', capability: 'shell.exec' } as const
  const shell = (input: unknown) => ({ id: 'run', kind: 'act', operation, input })

  test('an owner approval records the hash of the exact operation and input', () => {
    const result = authorDefinition({
      caller: vian,
      owner: KEITH_OWNER,
      definition: ladder(shell({ command: 'ls' })),
      approve: true,
      caps: CAPS,
      now: NOW,
    })
    if (!result.ok) throw new Error(result.message)
    expect(result.approvals).toEqual([
      {
        step: 'run',
        hash: actApprovalHash(operation, { command: 'ls' }),
        approvedBy: 'vian',
        approvedAt: NOW,
      },
    ])
  })

  test('a changed input without a new approval is refused; the stored approval is kept when unchanged', () => {
    const stored = [
      {
        step: 'run',
        hash: actApprovalHash(operation, { command: 'ls' }),
        approvedBy: 'vian',
        approvedAt: 1,
      },
    ]
    const same = authorDefinition({
      caller: vian,
      owner: KEITH_OWNER,
      definition: ladder(shell({ command: 'ls' })),
      existing: { owner: KEITH_OWNER, approvals: stored },
      caps: CAPS,
      now: NOW,
    })
    expect(same).toMatchObject({ ok: true, approvals: stored })

    expectRefused(
      authorDefinition({
        caller: vian,
        owner: KEITH_OWNER,
        definition: ladder(shell({ command: 'rm -rf /' })),
        existing: { owner: KEITH_OWNER, approvals: stored },
        caps: CAPS,
        now: NOW,
      }),
      'needs-approval',
      'steps.0.input',
    )
  })

  test('a member saves an act with approve set: still refused as author-rule', () => {
    expectRefused(
      author({ definition: ladder(shell({})), approve: true }),
      'author-rule',
      'steps.0.kind',
    )
  })

  test('an operation that changes ownership, a grant or a secret is refused for the owner too', () => {
    const transfer = {
      id: 'move',
      kind: 'act',
      operation: { kind: 'plugin.operation', plugin: 'people', operation: 'transfer-owner' },
      input: {},
    }
    expectRefused(
      authorDefinition({
        caller: vian,
        owner: KEITH_OWNER,
        definition: ladder(transfer),
        approve: true,
        caps: CAPS,
        now: NOW,
      }),
      'author-rule',
      'steps.0.operation',
    )
  })

  test('canonical JSON is stable across key order and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }], u: undefined })).toBe(
      '{"a":[2,{"c":2,"d":1}],"b":1}',
    )
    expect(actApprovalHash(operation, { x: 1, y: 2 })).toBe(
      actApprovalHash(operation, { y: 2, x: 1 }),
    )
  })
})

describe('caps', () => {
  test('a member is capped at 5 runs a day and 0.05 USD a run; the owner role is not', () => {
    const limits = (limit: Record<string, number>) => ({ ...ladder(notify()), limits: limit })
    expectRefused(
      author({ definition: limits({ maxRunsPerDay: 6 }) }),
      'cap',
      'limits.maxRunsPerDay',
    )
    expectRefused(
      author({ definition: limits({ budgetUsdPerRun: 0.06 }) }),
      'cap',
      'limits.budgetUsdPerRun',
    )
    expect(author({ definition: limits({ maxRunsPerDay: 5, budgetUsdPerRun: 0.05 }) }).ok).toBe(
      true,
    )
    expect(
      authorDefinition({
        caller: vian,
        owner: 'vian',
        definition: limits({ maxRunsPerDay: 20, budgetUsdPerRun: 0.5 }),
        caps: CAPS,
        now: NOW,
      }).ok,
    ).toBe(true)
  })

  test('the person protocol count is checked on creation only', () => {
    const full = { ...CAPS, ownedCount: 20 }
    expectRefused(author({ definition: ladder(notify()), caps: full }), 'cap')
    expect(
      author({
        definition: ladder(notify()),
        caps: full,
        existing: { owner: 'ana', approvals: [] },
      }).ok,
    ).toBe(true)
  })

  test('the step count is capped by the caps passed in', () => {
    const steps = [notify(), wait, { ...wait, id: 'pause-2' }]
    expectRefused(
      author({ definition: ladder(...steps), caps: { ...CAPS, maxSteps: 2 } }),
      'cap',
      'steps',
    )
  })
})

describe('the definition is validated', () => {
  test('an unknown step kind is refused with its path', () => {
    expectRefused(
      author({ definition: ladder({ id: 'x', kind: 'transfer', to: 'vian' }) }),
      'invalid',
      'steps.0.kind',
    )
  })

  test('a template marker in a text is refused', () => {
    const bad = { ...notify(), text: 'Hello {{name}}' }
    expectRefused(author({ definition: ladder(bad) }), 'invalid')
  })

  test('a goto to a missing step is refused', () => {
    const jump = { ...wait, next: 'nowhere' }
    expectRefused(author({ definition: ladder(jump) }), 'invalid', 'steps.0.next')
  })

  test('a proposal never holds an act, an urgent step, or a step for another person', () => {
    const propose = (step: unknown) => author({ definition: ladder(step), source: 'proposal' })
    expectRefused(propose(act()), 'invalid')
    expectRefused(propose({ ...notify(), urgent: true }), 'invalid')
    expectRefused(propose(notify('vian')), 'invalid')
    expect(propose(notify()).ok).toBe(true)
  })

  test('a proposal belongs to a person, never to keith', () => {
    expectRefused(
      authorDefinition({
        caller: vian,
        owner: KEITH_OWNER,
        definition: ladder(notify('bob')),
        source: 'proposal',
        caps: CAPS,
        now: NOW,
      }),
      'author-rule',
      'owner',
    )
  })
})

describe('system steps (P29): only the built-in succession protocol', () => {
  const system = { id: 'grace', kind: 'system', action: 'succession.begin-grace', next: 'end' }

  test('a person may not hold a system step, even in their own protocol', () => {
    expectRefused(author({ definition: ladder(system) }), 'author-rule', 'steps.0.kind')
  })

  test('the owner may not hold one in an ordinary keith-owned protocol either', () => {
    expectRefused(
      authorDefinition({
        caller: vian,
        owner: KEITH_OWNER,
        definition: ladder(system),
        caps: CAPS,
        now: NOW,
      }),
      'author-rule',
      'steps.0.kind',
    )
  })

  test('another built-in may not hold one', () => {
    expectRefused(
      authorDefinition({
        caller: vian,
        owner: KEITH_OWNER,
        definition: ladder(system),
        builtIn: 'reminder-missed',
        caps: CAPS,
        now: NOW,
      }),
      'author-rule',
      'steps.0.kind',
    )
  })

  test('the owner-absence built-in holds it, and only the owner role may author that built-in', () => {
    const accepted = authorDefinition({
      caller: vian,
      owner: KEITH_OWNER,
      definition: ladder(system),
      builtIn: 'owner-absence',
      caps: CAPS,
      now: NOW,
    })
    expect(accepted.ok).toBe(true)
    expectRefused(
      author({ definition: ladder(system), owner: KEITH_OWNER, builtIn: 'owner-absence' }),
      'author-rule',
      'owner',
    )
  })

  test('the dream built-in holds dreaming.run and no other system action (P35.5.1)', () => {
    const run = { id: 'dream-run', kind: 'system', action: 'dreaming.run', next: 'end' }
    const owned = { ...ladder(run), trigger: { kind: 'time', cron: '0 3 * * *' } }
    const accepted = author({ definition: owned, caller: vian, builtIn: 'dream' })
    expect(accepted.ok).toBe(true)
    const succession = { ...owned, steps: [{ ...run, action: 'succession.cancel' }] }
    expectRefused(
      author({ definition: succession, caller: vian, builtIn: 'dream' }),
      'author-rule',
      'steps.0.kind',
    )
    expectRefused(
      author({ definition: owned, caller: vian, builtIn: 'owner-absence' }),
      'author-rule',
      'steps.0.kind',
    )
    expectRefused(
      author({ definition: owned, caller: vian, builtIn: 'reminder-missed' }),
      'author-rule',
      'steps.0.kind',
    )
  })

  test('a signal.sinceRunStart cancel reads only the author own state, like signal.since', () => {
    const definition = {
      ...ladder(notify()),
      limits: { cancelWhen: { kind: 'signal.sinceRunStart', person: 'bob' } },
    }
    expectRefused(author({ definition }), 'author-rule', 'limits.cancelWhen.person')
    const own = {
      ...definition,
      limits: { cancelWhen: { kind: 'signal.sinceRunStart', person: 'ana' } },
    }
    expect(author({ definition: own }).ok).toBe(true)
  })
})

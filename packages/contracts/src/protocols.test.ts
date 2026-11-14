import { describe, expect, test } from 'bun:test'
import {
  AgendaAddInputSchema,
  cronFiresTooOften,
  MS_DAY,
  MS_HOUR,
  ProposalDefinitionSchema,
  ProtocolAnswerInputSchema,
  ProtocolBuiltInSchema,
  ProtocolDefinitionSchema,
  ProtocolRunSchema,
  SYSTEM_ACTIONS,
  TriggerSchema,
} from './protocols.ts'

/** A plain, mutable draft of a definition for the refusal table (deep edits by replacement, no casts). */
interface Draft {
  trigger: Record<string, unknown>
  conditions?: unknown[]
  limits?: Record<string, unknown>
  steps: Record<string, unknown>[]
  start: string
}

/** A valid ladder: notify, wait a day, ask with an answer branch and a timeout branch. */
function ladder(): Draft {
  return {
    trigger: { kind: 'time', cron: '0 9 * * *' },
    steps: [
      { id: 'remind', kind: 'notify', to: 'owner-of-run', text: 'Stand up', next: 'wait-day' },
      { id: 'wait-day', kind: 'wait', durationMs: MS_DAY, next: 'ask' },
      {
        id: 'ask',
        kind: 'ask',
        to: 'owner-of-run',
        text: 'Done?',
        options: ['yes', 'no'],
        timeoutMs: 2 * MS_HOUR,
        branches: [
          { when: 'answer:yes', goto: 'end' },
          { when: 'timeout', goto: 'end' },
        ],
      },
    ],
    start: 'remind',
  }
}

function stepAt(d: Draft, index: number): Record<string, unknown> {
  return d.steps[index] ?? {}
}

function issuePaths(input: unknown): string[] {
  const result = ProtocolDefinitionSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
}

describe('protocol definition', () => {
  test('a valid ladder parses with the default limits', () => {
    const parsed = ProtocolDefinitionSchema.safeParse(ladder())
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.limits.maxRunsPerDay).toBe(3)
      expect(parsed.data.limits.maxVisits).toBe(30)
      expect(parsed.data.limits.maxSteps).toBe(100)
      expect(parsed.data.conditions).toEqual([])
    }
  })

  test('a loop parses: a daily check-in goes back to its notify', () => {
    const loop: Draft = {
      trigger: { kind: 'time', cron: '0 9 * * *' },
      steps: [
        { id: 'check', kind: 'notify', to: 'owner-of-run', text: 'How was today?', next: 'pause' },
        { id: 'pause', kind: 'wait', durationMs: MS_DAY, next: 'check' },
      ],
      start: 'check',
    }
    expect(ProtocolDefinitionSchema.safeParse(loop).success).toBe(true)
  })

  test.each<[string, (d: Draft) => Draft, string]>([
    [
      'unknown step kind',
      (d) => ({ ...d, steps: [{ ...stepAt(d, 0), kind: 'shell' }, ...d.steps.slice(1)] }),
      'steps.0',
    ],
    [
      'unknown condition key',
      (d) => ({ ...d, conditions: [{ kind: 'agenda.busy', person: 'ana', extra: true }] }),
      'conditions.0',
    ],
    [
      'unknown condition kind',
      (d) => ({ ...d, conditions: [{ kind: 'eval', code: '1' }] }),
      'conditions.0',
    ],
    [
      'a template-like field in a notify text',
      (d) => ({ ...d, steps: [{ ...stepAt(d, 0), text: 'Hello {{name}}' }, ...d.steps.slice(1)] }),
      'steps.0.text',
    ],
    [
      'a wake instruction with a template marker',
      (d) => ({
        ...d,
        steps: [{ id: 'remind', kind: 'wake', to: 'owner-of-run', instruction: 'Say {{secret}}' }],
        start: 'remind',
      }),
      'steps.0.instruction',
    ],
    [
      'forty-one steps',
      (d) => ({
        ...d,
        steps: Array.from({ length: 41 }, (_, i) => ({
          id: `s${i}`,
          kind: 'wait',
          durationMs: MS_DAY,
          next: i < 40 ? `s${i + 1}` : 'end',
        })),
        start: 's0',
      }),
      'steps',
    ],
    [
      'a duplicate step id',
      (d) => ({ ...d, steps: [stepAt(d, 0), { ...stepAt(d, 1), id: 'remind' }, stepAt(d, 2)] }),
      'steps.1.id',
    ],
    [
      'a goto to a missing step',
      (d) => ({ ...d, steps: [{ ...stepAt(d, 0), next: 'nowhere' }, ...d.steps.slice(1)] }),
      'steps.0.next',
    ],
    [
      'a branch goto to a missing step',
      (d) => ({
        ...d,
        steps: [
          stepAt(d, 0),
          stepAt(d, 1),
          { ...stepAt(d, 2), branches: [{ when: 'timeout', goto: 'nowhere' }] },
        ],
      }),
      'steps.2.branches.0.goto',
    ],
    ['a start that is not a step', (d) => ({ ...d, start: 'missing' }), 'start'],
    [
      'an answer branch for an option the ask does not have',
      (d) => ({
        ...d,
        steps: [
          stepAt(d, 0),
          stepAt(d, 1),
          { ...stepAt(d, 2), branches: [{ when: 'answer:maybe', goto: 'end' }] },
        ],
      }),
      'steps.2.branches.0.when',
    ],
    [
      'a timeout branch on a notify',
      (d) => ({
        ...d,
        steps: [
          { ...stepAt(d, 0), branches: [{ when: 'timeout', goto: 'end' }] },
          ...d.steps.slice(1),
        ],
      }),
      'steps.0.branches.0.when',
    ],
    [
      'a condition branch without a condition',
      (d) => ({
        ...d,
        steps: [
          { ...stepAt(d, 0), branches: [{ when: 'condition', goto: 'end' }] },
          ...d.steps.slice(1),
        ],
      }),
      'steps.0.branches.0.condition',
    ],
    [
      'a cron that fires every five minutes',
      (d) => ({ ...d, trigger: { kind: 'time', cron: '*/5 * * * *' } }),
      'trigger.cron',
    ],
    [
      'afterMs over ninety days',
      (d) => ({ ...d, trigger: { kind: 'absence', person: 'ana', afterMs: 91 * MS_DAY } }),
      'trigger.afterMs',
    ],
    [
      'an event trigger with both afterMs and until',
      (d) => ({
        ...d,
        trigger: {
          kind: 'event',
          type: 'brain.amygdala.wait',
          afterMs: MS_HOUR,
          until: { field: 'expiresAt', beforeMs: MS_HOUR },
        },
      }),
      'trigger',
    ],
    [
      'an event type that is not in the feed',
      (d) => ({ ...d, trigger: { kind: 'event', type: 'task-changed' } }),
      'trigger.type',
    ],
  ])('refused: %s', (_name, mutate, path) => {
    const paths = issuePaths(mutate(ladder()))
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.some((p) => p.startsWith(path))).toBe(true)
  })

  test('a limit above its range is refused with its path', () => {
    expect(issuePaths({ ...ladder(), limits: { maxRunsPerDay: 21 } })).toContain(
      'limits.maxRunsPerDay',
    )
  })
})

describe('triggers', () => {
  test.each<[Record<string, unknown>, boolean]>([
    [{ kind: 'time', cron: '0 9 * * *' }, true],
    [{ kind: 'time', cron: '0,30 9 * * *' }, true],
    [{ kind: 'time', cron: '*/15 * * * *' }, true],
    [{ kind: 'time', at: 1_800_000_000_000 }, true],
    [{ kind: 'time', cron: '0 9 * * *', at: 1_800_000_000_000 }, false],
    [{ kind: 'time' }, false],
    [{ kind: 'absence', person: 'ana', afterMs: MS_HOUR }, true],
    [{ kind: 'absence', person: 'ana', afterMs: MS_HOUR - 1 }, false],
    [{ kind: 'signal', type: 'client.disconnected', filter: { kind: 'tui' } }, true],
    [{ kind: 'signal', type: 'presence.changed' }, false],
    [{ kind: 'event', type: 'delivery.failed', filter: { source: 'plugin:reminders' } }, true],
    [
      { kind: 'event', type: 'brain.amygdala.wait', until: { field: 'expiresAt', beforeMs: 0 } },
      true,
    ],
    [
      {
        kind: 'event',
        type: 'brain.amygdala.wait',
        filter: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
      },
      false,
    ],
  ])('trigger %j valid: %s', (trigger, valid) => {
    expect(TriggerSchema.safeParse(trigger).success).toBe(valid)
  })

  test('cron minute rule: fires less than 15 minutes apart are refused', () => {
    expect(cronFiresTooOften('*/5 * * * *')).toBe(true)
    expect(cronFiresTooOften('* * * * *')).toBe(true)
    expect(cronFiresTooOften('0,10 * * * *')).toBe(true)
    expect(cronFiresTooOften('0,30 * * * *')).toBe(false)
    expect(cronFiresTooOften('*/15 * * * *')).toBe(false)
    expect(cronFiresTooOften('0 9 * * *')).toBe(false)
    expect(cronFiresTooOften('0 9 * *')).toBe(true)
    expect(cronFiresTooOften('0-30 9 * * *')).toBe(true)
  })
})

describe('proposals', () => {
  const proposal = (step: Record<string, unknown>) => ({
    trigger: { kind: 'time', at: 1_800_000_000_000 },
    steps: [step],
    start: 'quiet',
  })
  const note = { id: 'quiet', kind: 'notify', to: 'owner-of-run', text: 'Quiet hours start now' }
  const pathsOf = (input: unknown) => {
    const result = ProposalDefinitionSchema.safeParse(input)
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
  }

  test('a simple reminder proposal parses', () => {
    expect(ProposalDefinitionSchema.safeParse(proposal(note)).success).toBe(true)
  })

  test('a proposal never holds an act', () => {
    const act = {
      id: 'quiet',
      kind: 'act',
      operation: { kind: 'plugin.operation', plugin: 'reminders', operation: 'cancel' },
      input: {},
    }
    expect(pathsOf(proposal(act))).toContain('steps.0.kind')
  })

  test('a proposal is never urgent', () => {
    expect(pathsOf(proposal({ ...note, urgent: true }))).toContain('steps.0.urgent')
  })

  test('a proposal addresses the owner of the run only', () => {
    expect(pathsOf(proposal({ ...note, to: 'bima' }))).toContain('steps.0.to')
  })

  test('a proposal never holds a system step', () => {
    const system = { id: 'quiet', kind: 'system', action: 'succession.cancel' }
    expect(pathsOf(proposal(system))).toContain('steps.0.kind')
  })
})

describe('the P29 extensions of the protocol contract', () => {
  const base = (steps: Record<string, unknown>[], limits: Record<string, unknown> = {}) => ({
    trigger: { kind: 'absence', person: 'ana', afterMs: MS_DAY },
    steps,
    limits,
    start: (steps[0] as { id: string }).id,
  })
  const issuesOf = (input: unknown) => {
    const result = ProtocolDefinitionSchema.safeParse(input)
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
  }

  test('a system step takes one of the three succession actions and nothing else', () => {
    for (const action of ['succession.begin-grace', 'succession.open-claim', 'succession.cancel']) {
      expect(
        ProtocolDefinitionSchema.safeParse(
          base([{ id: 'grace', kind: 'system', action, next: 'end' }]),
        ).success,
      ).toBe(true)
    }
    expect(
      issuesOf(base([{ id: 'grace', kind: 'system', action: 'succession.transfer' }])),
    ).toContain('steps.0.action')
  })

  test('a system step may branch on ok or failed like notify, wake and act', () => {
    const ok = base([
      {
        id: 'grace',
        kind: 'system',
        action: 'succession.begin-grace',
        branches: [{ when: 'failed', goto: 'end' }],
      },
    ])
    expect(issuesOf(ok)).toEqual([])
    const wrong = base([
      {
        id: 'grace',
        kind: 'system',
        action: 'succession.cancel',
        branches: [{ when: 'timeout', goto: 'end' }],
      },
    ])
    expect(issuesOf(wrong)).toContain('steps.0.branches.0.when')
  })

  test('notify takes channels best or all, and nothing else', () => {
    const note = (channels: unknown) =>
      base([{ id: 'tell', kind: 'notify', to: 'ana', text: 'Hello', channels }])
    expect(ProtocolDefinitionSchema.safeParse(note('all')).success).toBe(true)
    expect(ProtocolDefinitionSchema.safeParse(note('best')).success).toBe(true)
    expect(issuesOf(note('some'))).toContain('steps.0.channels')
  })

  test('limits.onCancel names a step of the definition', () => {
    const steps = [{ id: 'tell', kind: 'notify', to: 'ana', text: 'Hello' }]
    expect(issuesOf(base(steps, { onCancel: 'tell' }))).toEqual([])
    expect(issuesOf(base(steps, { onCancel: 'nowhere' }))).toEqual(['limits.onCancel'])
  })

  test('signal.sinceRunStart is a condition with a person, usable in cancelWhen', () => {
    const steps = [{ id: 'tell', kind: 'notify', to: 'ana', text: 'Hello' }]
    expect(
      issuesOf(base(steps, { cancelWhen: { kind: 'signal.sinceRunStart', person: 'ana' } })),
    ).toEqual([])
    expect(
      issuesOf(base(steps, { cancelWhen: { kind: 'signal.sinceRunStart', person: 'ana', ms: 1 } })),
    ).toContain('limits.cancelWhen')
  })
})

describe('runs, answers and agenda', () => {
  test('a run row parses and a bad status is refused', () => {
    const run = {
      id: 'r1',
      protocolId: 'p1',
      version: 1,
      person: 'ana',
      triggerRef: 'time:2026-11-10T09:00',
      status: 'waiting',
      step: 'ask',
      visits: { remind: 1 },
      wakeAt: 1_800_000_000_000,
      costUsd: 0,
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      endedAt: null,
    }
    expect(ProtocolRunSchema.safeParse(run).success).toBe(true)
    expect(ProtocolRunSchema.safeParse({ ...run, status: 'sleeping' }).success).toBe(false)
  })

  test('an answer needs an option or a text', () => {
    expect(ProtocolAnswerInputSchema.safeParse({ runId: 'r1' }).success).toBe(false)
    expect(ProtocolAnswerInputSchema.safeParse({ runId: 'r1', option: 'yes' }).success).toBe(true)
    expect(ProtocolAnswerInputSchema.safeParse({ runId: 'r1', text: 'later' }).success).toBe(true)
  })

  test('an agenda add defaults to tentative and never takes a person', () => {
    const parsed = AgendaAddInputSchema.safeParse({ what: 'meeting', startsAt: 1_000 })
    expect(parsed.success && parsed.data.status).toBe('tentative')
    expect(
      AgendaAddInputSchema.safeParse({ what: 'x', startsAt: 1_000, person: 'bima' }).success,
    ).toBe(false)
    expect(
      AgendaAddInputSchema.safeParse({ what: 'x', startsAt: 1_000, endsAt: 1_000 }).success,
    ).toBe(false)
  })
})

describe('the P35 extensions of the protocol contract (dreaming)', () => {
  const base = (steps: Record<string, unknown>[]) => ({
    trigger: { kind: 'time', cron: '30 3 * * *' },
    steps,
    start: (steps[0] as { id: string }).id,
  })

  test('`dream` is a built-in protocol and the other built-ins still parse', () => {
    expect(ProtocolBuiltInSchema.safeParse('dream').success).toBe(true)
    expect(ProtocolBuiltInSchema.safeParse('owner-absence').success).toBe(true)
    expect(ProtocolBuiltInSchema.safeParse('dreams').success).toBe(false)
  })

  test('`dreaming.run` is a system action and a system step may name it', () => {
    expect(SYSTEM_ACTIONS).toContain('dreaming.run')
    expect(
      ProtocolDefinitionSchema.safeParse(
        base([{ id: 'dream', kind: 'system', action: 'dreaming.run', next: 'end' }]),
      ).success,
    ).toBe(true)
    expect(
      ProtocolDefinitionSchema.safeParse(
        base([{ id: 'dream', kind: 'system', action: 'dreaming.stop', next: 'end' }]),
      ).success,
    ).toBe(false)
  })
})

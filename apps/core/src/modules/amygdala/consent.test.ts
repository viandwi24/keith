// The consent hook (ADR-0036, ADR-0039): the trigger of a turn, the transcript, the source of each tool and the effect give an answer that is
// cached by call id, so a re-validation answers the same and the attention list can say how a waiting call is confirmed.
import { describe, expect, test } from 'bun:test'
import type { GuardTranscriptEntry, HarnessContext, ToolRisk, TurnKind } from 'eharness'
import { resolvePlugin } from 'eharness/testing'
import { createConsent } from './consent.ts'

const user = (text = 'do it'): GuardTranscriptEntry => ({ role: 'user', text })
const call = (toolName: string): GuardTranscriptEntry => ({
  role: 'tool-call',
  toolName,
  input: {},
})

const REVERSIBLE = { risk: 'write', reversible: true, source: 'trusted' }
const META = {
  persona_template: { ...REVERSIBLE, effect: 'behavior' },
  style_set: REVERSIBLE,
  persona_get: { risk: 'read', source: 'trusted' },
  web_fetch: { risk: 'external', source: 'outside' },
  // the core's motorConsentEffect makes a call that does not run unasked `destructive` (ADR-0039 §1)
  motor_remote: { risk: 'external', source: 'outside', effect: 'destructive' },
  agent: undefined,
  notes_create: { risk: 'write', source: 'trusted' },
  plugin_delete: { risk: 'destructive', source: 'trusted' },
} as const

const RISK: Record<string, ToolRisk | undefined> = {
  persona_template: 'write',
  style_set: 'write',
  persona_get: 'read',
  web_fetch: 'external',
  motor_remote: 'external',
  notes_create: 'write',
  plugin_delete: 'destructive',
}

type Role = 'front' | 'worker'
const FRONT = 'front:owner'
const WORKER = 'front:owner:agent:t1'

async function setup(options: Parameters<typeof createConsent>[0] = {}) {
  const consent = createConsent(options)
  const front = await resolvePlugin(consent.plugin('front'))
  const worker = await resolvePlugin(consent.plugin('worker'))
  const hooks = { front, worker }
  const turn = (role: Role, session: string, kind: TurnKind) =>
    hooks[role].runHook('turn.start', { kind, input: undefined }, {
      session: { id: session },
    } as Partial<HarnessContext>)
  const approve = (
    role: Role,
    session: string,
    toolName: keyof typeof META | string,
    toolCallId: string,
    transcript: GuardTranscriptEntry[],
    extra: { parent?: { sessionId: string; toolCallId?: string } } = {},
  ) =>
    hooks[role].runHook(
      'tool.approve',
      {
        toolName,
        toolCallId,
        input: {},
        toolMetadata: META[toolName as keyof typeof META],
        ...(RISK[toolName] === undefined ? {} : { risk: RISK[toolName] }),
        transcript: () => transcript,
      },
      {
        session: { id: session, ...(extra.parent === undefined ? {} : { parent: extra.parent }) },
      } as Partial<HarnessContext>,
    )
  return { consent, turn, approve }
}

describe('a front turn started by the person', () => {
  test('a reversible write after the person asked runs, with no tier', async () => {
    const { consent, turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    expect(await approve('front', FRONT, 'persona_template', 'c1', [user()])).toBe('approved')
    expect(consent.registry.tierOf(FRONT, 'c1')).toBeUndefined()
    expect(consent.registry.contextOf(FRONT, 'c1')).toBe('clean')
  })

  test('trusted reads between the message and the write keep it clean', async () => {
    const { turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    expect(await approve('front', FRONT, 'persona_get', 'r1', [user()])).toBe('approved')
    expect(
      await approve('front', FRONT, 'persona_template', 'c1', [user(), call('persona_get')]),
    ).toBe('approved')
  })

  test('after a web_fetch the same write asks in conversation', async () => {
    const { consent, turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    await approve('front', FRONT, 'web_fetch', 'w1', [user()])
    const answer = await approve('front', FRONT, 'persona_template', 'c1', [
      user(),
      call('web_fetch'),
    ])
    expect(answer).toMatchObject({ type: 'user-approval' })
    expect(consent.registry.tierOf(FRONT, 'c1')).toBe('conversation')
    expect(consent.registry.contextOf(FRONT, 'c1')).toBe('tainted')
  })

  test('a web_fetch itself is a read for consent: it runs, whatever came before', async () => {
    const { turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    expect(await approve('front', FRONT, 'web_fetch', 'w1', [user(), call('agent')])).toBe(
      'approved',
    )
  })

  test('a new person message after outside content makes it clean again', async () => {
    const { turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    await approve('front', FRONT, 'web_fetch', 'w1', [user()])
    const transcript = [user('look it up'), call('web_fetch'), user('now switch to butler')]
    expect(await approve('front', FRONT, 'persona_template', 'c2', transcript)).toBe('approved')
  })

  test('a destructive or external call asks in conversation when clean and on a device when tainted', async () => {
    const { consent, turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    expect(await approve('front', FRONT, 'motor_remote', 's1', [user()])).toMatchObject({
      type: 'user-approval',
    })
    expect(consent.registry.tierOf(FRONT, 's1')).toBe('conversation')
    expect(
      await approve('front', FRONT, 'plugin_delete', 'd1', [user(), call('web_fetch')]),
    ).toMatchObject({
      type: 'user-approval',
    })
    expect(consent.registry.tierOf(FRONT, 'd1')).toBe('device')
  })

  test('a plain write is local: no opinion, clean or after outside content (ADR-0039); never denied', async () => {
    const { consent, turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    expect(await approve('front', FRONT, 'notes_create', 'n1', [user()])).toBeUndefined()
    expect(
      await approve('front', FRONT, 'notes_create', 'n2', [user(), call('web_fetch')]),
    ).toBeUndefined()
    expect(consent.registry.tierOf(FRONT, 'n2')).toBeUndefined()
  })
})

describe('a front turn with no message of the person', () => {
  test('a wake turn is tainted even with a person message earlier in the transcript', async () => {
    const { consent, turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    await turn('front', FRONT, 'wake')
    expect(await approve('front', FRONT, 'persona_template', 'c1', [user()])).toMatchObject({
      type: 'user-approval',
    })
    expect(consent.registry.tierOf(FRONT, 'c1')).toBe('conversation')
    expect(await approve('front', FRONT, 'motor_remote', 's1', [user()])).toMatchObject({
      type: 'user-approval',
    })
    expect(consent.registry.tierOf(FRONT, 's1')).toBe('device')
  })

  test('a respond turn continues the trigger of the turn before it', async () => {
    const { consent, turn, approve } = await setup()
    await turn('front', FRONT, 'wake')
    await turn('front', FRONT, 'respond')
    await approve('front', FRONT, 'persona_template', 'c1', [user()])
    expect(consent.registry.contextOf(FRONT, 'c1')).toBe('tainted')
    await turn('front', FRONT, 'send')
    await turn('front', FRONT, 'respond')
    expect(await approve('front', FRONT, 'persona_template', 'c2', [user()])).toBe('approved')
  })

  test('a session whose start is unknown is tainted (a restart forgot the trigger)', async () => {
    const { consent, approve } = await setup()
    await approve('front', FRONT, 'persona_template', 'c1', [user()])
    expect(consent.registry.contextOf(FRONT, 'c1')).toBe('tainted')
  })

  test('no message of the person in view is tainted', async () => {
    const { consent, turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    await approve('front', FRONT, 'persona_template', 'c1', [])
    expect(consent.registry.contextOf(FRONT, 'c1')).toBe('tainted')
  })

  test('a transcript that throws counts as tainted and the hook does not throw', async () => {
    const consent = createConsent()
    const front = await resolvePlugin(consent.plugin('front'))
    const ctx = { session: { id: FRONT } } as Partial<HarnessContext>
    await front.runHook('turn.start', { kind: 'send', input: undefined }, ctx)
    const answer = await front.runHook(
      'tool.approve',
      {
        toolName: 'persona_template',
        toolCallId: 'c1',
        input: {},
        toolMetadata: META.persona_template,
        risk: 'write',
        transcript: () => {
          throw new Error('no wire')
        },
      },
      ctx,
    )
    expect(answer).toMatchObject({ type: 'user-approval' })
    expect(consent.registry.tierOf(FRONT, 'c1')).toBe('conversation')
  })
})

describe('re-validation answers the same', () => {
  test('a call decided tainted stays asked at the same tier when the wire later looks clean', async () => {
    const { consent, turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    const first = await approve('front', FRONT, 'persona_template', 'c1', [
      user(),
      call('web_fetch'),
    ])
    await turn('front', FRONT, 'respond')
    const again = await approve('front', FRONT, 'persona_template', 'c1', [user('yes do it')])
    expect(again).toEqual(first)
    expect(consent.registry.tierOf(FRONT, 'c1')).toBe('conversation')
  })

  test('a call decided clean stays clean when the wire later holds outside calls', async () => {
    const { turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    expect(await approve('front', FRONT, 'persona_template', 'c1', [user()])).toBe('approved')
    expect(
      await approve('front', FRONT, 'persona_template', 'c1', [user(), call('web_fetch')]),
    ).toBe('approved')
  })

  test('the same call id in another session is a different call', async () => {
    const { turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    await turn('front', 'front:ana', 'wake')
    expect(await approve('front', FRONT, 'persona_template', 'c1', [user()])).toBe('approved')
    expect(await approve('front', 'front:ana', 'persona_template', 'c1', [user()])).toMatchObject({
      type: 'user-approval',
    })
  })
})

describe('a worker', () => {
  const PARENT = { sessionId: FRONT, toolCallId: 'a1' }

  test('delegated from a clean front call: a shell command asks in conversation', async () => {
    const { consent, turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    await approve('front', FRONT, 'agent', 'a1', [user()])
    expect(consent.registry.contextOf(FRONT, 'a1')).toBe('clean')
    expect(
      await approve('worker', WORKER, 'motor_remote', 's1', [], { parent: PARENT }),
    ).toMatchObject({ type: 'user-approval' })
    expect(consent.registry.tierOf(WORKER, 's1')).toBe('conversation')
  })

  test('delegated from a tainted front call: a shell command goes to a device', async () => {
    const { consent, turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    await approve('front', FRONT, 'agent', 'a1', [user(), call('web_fetch')])
    expect(consent.registry.contextOf(FRONT, 'a1')).toBe('tainted')
    await approve('worker', WORKER, 'motor_remote', 's1', [], { parent: PARENT })
    expect(consent.registry.tierOf(WORKER, 's1')).toBe('device')
  })

  test('delegated cleanly, then it read a page: the shell command goes to a device', async () => {
    const { consent, turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    await approve('front', FRONT, 'agent', 'a1', [user()])
    await approve('worker', WORKER, 'web_fetch', 'w1', [], { parent: PARENT })
    await approve('worker', WORKER, 'motor_remote', 's1', [call('web_fetch')], { parent: PARENT })
    expect(consent.registry.tierOf(WORKER, 's1')).toBe('device')
  })

  test('delegated from a wake turn, or from an unknown call, or with no parent: device', async () => {
    const { consent, turn, approve } = await setup()
    await turn('front', FRONT, 'wake')
    await approve('front', FRONT, 'agent', 'a1', [user()])
    await approve('worker', WORKER, 'motor_remote', 's1', [], { parent: PARENT })
    expect(consent.registry.tierOf(WORKER, 's1')).toBe('device')
    await approve('worker', WORKER, 'motor_remote', 's2', [], {
      parent: { sessionId: FRONT, toolCallId: 'unknown' },
    })
    expect(consent.registry.tierOf(WORKER, 's2')).toBe('device')
    await approve('worker', WORKER, 'motor_remote', 's3', [])
    expect(consent.registry.tierOf(WORKER, 's3')).toBe('device')
  })

  test('the trigger of a worker session is never read from a front turn', async () => {
    const { consent, turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    await turn('worker', WORKER, 'wake')
    await approve('front', FRONT, 'agent', 'a1', [user()])
    await approve('worker', WORKER, 'motor_remote', 's1', [], { parent: PARENT })
    expect(consent.registry.tierOf(WORKER, 's1')).toBe('conversation')
  })
})

describe('the risk of a call', () => {
  test('effectOf of the options wins over the tool risk, and the web tools read as none', async () => {
    const { consent, turn, approve } = await setup({
      effectOf: (name) => (name === 'motor_remote' ? { effect: 'none' } : undefined),
    })
    await turn('front', FRONT, 'send')
    expect(await approve('front', FRONT, 'motor_remote', 's1', [user(), call('web_fetch')])).toBe(
      'approved',
    )
    expect(consent.registry.tierOf(FRONT, 's1')).toBeUndefined()
  })

  test('the bound forgets the oldest decisions', async () => {
    const { consent, turn, approve } = await setup({ max: 2 })
    await turn('front', FRONT, 'send')
    for (const id of ['c1', 'c2', 'c3']) await approve('front', FRONT, 'persona_get', id, [user()])
    expect(consent.registry.contextOf(FRONT, 'c1')).toBeUndefined()
    expect(consent.registry.contextOf(FRONT, 'c3')).toBe('clean')
  })

  test('a tool the hooks saw with its metadata is known by name in later transcripts', async () => {
    const { consent, turn, approve } = await setup()
    await turn('front', FRONT, 'send')
    await approve('front', FRONT, 'persona_get', 'r1', [user()])
    expect(consent.learnedSource('persona_get')).toBe('trusted')
    expect(consent.learnedSource('never_seen')).toBeUndefined()
  })
})

describe('a shell command from a client that has not stepped up', () => {
  const runShell = async (elevated: boolean) => {
    const consent = createConsent({
      elevatedOf: () => elevated,
      stepUpCall: (name) => name === 'motor_remote',
    })
    const front = await resolvePlugin(consent.plugin('front'))
    const ctx = { session: { id: FRONT }, principal: { id: 'owner' } } as Partial<HarnessContext>
    await front.runHook('turn.start', { kind: 'send', input: undefined }, ctx)
    const answer = await front.runHook(
      'tool.approve',
      {
        toolName: 'motor_remote',
        toolCallId: 'sh1',
        input: {},
        toolMetadata: META.motor_remote,
        risk: 'external',
        transcript: () => [user()],
      },
      ctx,
    )
    return { answer, tier: consent.registry.tierOf(FRONT, 'sh1') }
  }

  test('waits on a device: a yes in the chat could not answer it without the step-up', async () => {
    const { answer, tier } = await runShell(false)
    expect(answer).toMatchObject({ type: 'user-approval' })
    expect(tier).toBe('device')
  })

  test('a stepped-up client is asked in the conversation', async () => {
    const { answer, tier } = await runShell(true)
    expect(answer).toMatchObject({ type: 'user-approval' })
    expect(tier).toBe('conversation')
  })
})

describe('a step-up tool from a client that has not stepped up', () => {
  const principal = { id: 'owner' }
  const approveAs = async (
    elevated: boolean | undefined,
    toolCallId: string,
    transcript: GuardTranscriptEntry[],
    toolName = 'persona_template',
  ) => {
    let now = elevated
    const consent = createConsent({ elevatedOf: () => now })
    const front = await resolvePlugin(consent.plugin('front'))
    const ctx = { session: { id: FRONT }, principal } as Partial<HarnessContext>
    await front.runHook('turn.start', { kind: 'send', input: undefined }, ctx)
    const run = () =>
      front.runHook(
        'tool.approve',
        {
          toolName,
          toolCallId,
          input: {},
          toolMetadata: REVERSIBLE,
          risk: 'write',
          transcript: () => transcript,
        },
        ctx,
      )
    return {
      consent,
      run,
      step: (value: boolean) => {
        now = value
      },
    }
  }

  test('a clean persona switch from a cold client runs: undo is its guard (no step-up for a clean reversible change)', async () => {
    const { consent, run } = await approveAs(false, 'c1', [user()])
    expect(await run()).toBe('approved')
    expect(consent.registry.tierOf(FRONT, 'c1')).toBeUndefined()
  })

  test('a tainted persona switch from a cold client waits on a device', async () => {
    const { consent, run } = await approveAs(false, 'c1', [user(), call('web_fetch')])
    expect(await run()).toMatchObject({ type: 'user-approval' })
    expect(consent.registry.tierOf(FRONT, 'c1')).toBe('device')
  })

  test('an unknown client counts as not stepped up (tainted)', async () => {
    const { consent, run } = await approveAs(undefined, 'c1', [user(), call('web_fetch')])
    expect(await run()).toMatchObject({ type: 'user-approval' })
    expect(consent.registry.tierOf(FRONT, 'c1')).toBe('device')
  })

  test('a stepped-up client still runs it', async () => {
    const { run } = await approveAs(true, 'c1', [user()])
    expect(await run()).toBe('approved')
  })

  test('the first decision is cached by call id: a step-up between the two never flips it', async () => {
    const { consent, run, step } = await approveAs(false, 'c1', [user(), call('web_fetch')])
    const first = await run()
    step(true)
    expect(await run()).toEqual(first)
    expect(consent.registry.tierOf(FRONT, 'c1')).toBe('device')
  })

  test('a tool that is not a step-up tool is not held back', async () => {
    const { run } = await approveAs(false, 'c1', [user()], 'style_set')
    expect(await run()).toBe('approved')
  })
})

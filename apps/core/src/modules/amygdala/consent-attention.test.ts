// The attention items say how a waiting call is confirmed (ADR-0036 §4): `consent` is `conversation` or `device`, and a call whose tier
// is unknown (a restart, a rule that is not the consent table) or that the owner answers for a member counts as `device`.
import { describe, expect, test } from 'bun:test'
import type { HarnessAgent } from 'eharness'
import { inMemoryActivityStore } from 'eharness/activity'
import type { Cortex } from '../cortex/index.ts'
import { attentionOptions } from './attention.ts'
import { createConsent } from './consent.ts'

const OWNER = { id: 'owner', name: 'Owner', role: 'owner', status: 'active' } as never

function build(withConsent: boolean) {
  const consent = createConsent()
  const options = attentionOptions({
    generations: { current: () => 0 },
    lead: () => ({}) as unknown as HarnessAgent,
    cortex: { worker: () => undefined } as unknown as Cortex,
    tasks: { get: () => undefined } as never,
    people: { list: async () => [OWNER], get: async () => OWNER },
    store: inMemoryActivityStore(),
    ...(withConsent ? { consent: consent.registry } : {}),
  })
  return {
    consent,
    decorate: options.decorate as (item: unknown, call: unknown) => Promise<unknown>,
  }
}

const call = { principal: { personId: 'owner', role: 'owner' as const } }
const item = (toolName: string, toolCallId: string, sessionId = 'front:owner') => ({
  kind: 'approval',
  sessionId,
  toolName,
  toolCallId,
  input: {},
  createdAt: null,
})

describe('attention items carry the consent tier', () => {
  test('the tier the hook stored is on the item; an unknown call is device', async () => {
    const { consent, decorate } = build(true)
    const front = await (await import('eharness/testing')).resolvePlugin(consent.plugin('front'))
    const ctx = { session: { id: 'front:owner' } }
    await front.runHook('turn.start', { kind: 'send', input: undefined }, ctx as never)
    await front.runHook(
      'tool.approve',
      {
        toolName: 'persona_template',
        toolCallId: 'c1',
        input: {},
        toolMetadata: { risk: 'write', reversible: true, source: 'trusted' },
        risk: 'write',
        transcript: () => [
          { role: 'user', text: 'x' },
          { role: 'tool-call', toolName: 'web_fetch', input: {} },
        ],
      },
      ctx as never,
    )
    expect(await decorate(item('persona_template', 'c1'), call)).toMatchObject({
      consent: 'conversation',
      scopable: true,
    })
    expect(await decorate(item('persona_template', 'after-restart'), call)).toMatchObject({
      consent: 'device',
    })
    expect(await decorate({ ...item('x', 'c1'), toolCallId: undefined }, call)).toMatchObject({
      consent: 'device',
    })
  })

  test('without the registry the items carry no consent field', async () => {
    const { decorate } = build(false)
    expect(await decorate(item('persona_template', 'c1'), call)).toEqual({ scopable: true })
  })
})

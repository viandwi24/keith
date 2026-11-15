// Answering the approval of a persona or model-switch tool (ADR-0034 §3, §8): the person answers their own session, but a
// remote client that has not stepped up gets the step-up denial; the elevated local socket and a stepped-up remote pass.
import { describe, expect, test } from 'bun:test'
import { KEITH_STEP_UP_REQUIRED, STEP_UP_TOOLS } from '@keith/contracts'
import type { HarnessAgent } from 'eharness'
import { inMemoryActivityStore } from 'eharness/activity'
import type { Cortex } from '../cortex/index.ts'
import { attentionOptions } from './attention.ts'

const OWNER = { id: 'owner', name: 'Owner', role: 'owner', status: 'active' } as never

function build(toolName: string) {
  const lead = {
    peek: () => ({
      pending: async () => ({
        approvals: [{ approvalId: 'a1', toolName, input: {} }],
      }),
    }),
  } as unknown as HarnessAgent
  return attentionOptions({
    generations: { current: () => 0 },
    lead: () => lead,
    cortex: { worker: () => undefined } as unknown as Cortex,
    tasks: { get: () => undefined } as never,
    people: { list: async () => [OWNER], get: async () => OWNER },
    store: inMemoryActivityStore(),
  })
}

const answer = (toolName: string, principal: { role: 'owner' | 'member'; elevated?: boolean }) =>
  build(toolName).canAnswer?.({
    principal: { personId: 'owner', ...principal },
    request: new Request('http://x'),
    sessionId: 'front:owner',
    attentionId: 'a1',
  } as never)

describe('STEP_UP_TOOLS', () => {
  test('holds the three persona changes and model_role_set, not the reads', () => {
    expect([...STEP_UP_TOOLS].sort()).toEqual([
      'model_role_set',
      'persona_edit',
      'persona_restore',
      'persona_template',
    ])
  })
})

describe('canAnswer for a step-up tool', () => {
  test.each([...STEP_UP_TOOLS])(
    '%s: a remote non-elevated principal is denied with the step-up code',
    async (tool) => {
      expect(await answer(tool, { role: 'owner' })).toMatchObject({
        deny: 403,
        code: KEITH_STEP_UP_REQUIRED,
      })
    },
  )

  test.each([...STEP_UP_TOOLS])(
    '%s: an elevated principal (local socket or stepped-up) answers',
    async (tool) => {
      expect(await answer(tool, { role: 'owner', elevated: true })).toBe(true)
    },
  )

  test('persona_get and model_roles_get (reads) need no step-up', async () => {
    expect(await answer('persona_get', { role: 'owner' })).toBe(true)
    expect(await answer('model_roles_get', { role: 'owner' })).toBe(true)
  })

  test('another tool needs no step-up from the person who owns the session', async () => {
    expect(await answer('document_save', { role: 'owner' })).toBe(true)
  })
})

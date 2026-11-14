import { describe, expect, test } from 'bun:test'
import { defineNodeCapability } from '@keith/contracts'
import { z } from 'zod'
import { BUILTIN_CAPABILITY_SPECS, createNodeCapabilityRegistry } from '../nodes/index.ts'
import { MOTOR_REMOTE_TOOL, runsUnasked } from './remote.ts'
import { motorAskOf, ownerAnswers } from './risk.ts'

const BUILTIN = createNodeCapabilityRegistry()

describe('who answers a machine approval', () => {
  test('shell.exec goes to the owner; system.info and other tools do not', () => {
    const shell = { node: 'laptop-e', capability: 'shell.exec', input: { command: 'ls -la' } }
    expect(ownerAnswers(MOTOR_REMOTE_TOOL, shell)).toBe(true)
    expect(ownerAnswers(MOTOR_REMOTE_TOOL, { node: 'n', capability: 'system.info' })).toBe(false)
    expect(ownerAnswers('web_fetch', shell)).toBe(false)
  })

  test('an unknown or unreadable call is never left to a member', () => {
    expect(ownerAnswers(MOTOR_REMOTE_TOOL, { node: 'n', capability: 'camera' })).toBe(true)
    expect(ownerAnswers(MOTOR_REMOTE_TOOL, 'garbage')).toBe(true)
    expect(ownerAnswers(MOTOR_REMOTE_TOOL, undefined)).toBe(true)
  })

  test('the ask shows node, capability and command', () => {
    expect(
      motorAskOf(MOTOR_REMOTE_TOOL, {
        node: 'laptop-e',
        capability: 'shell.exec',
        input: { command: 'df -h' },
      }),
    ).toEqual({ node: 'laptop-e', capability: 'shell.exec', command: 'df -h' })
    expect(motorAskOf('other', {})).toBeUndefined()
  })
})

describe('sandbox.run: without network nothing is asked, with network the owner is (P31.4.1)', () => {
  const code = { language: 'python', code: 'print(1)' }
  const call = (input: unknown) => ({ node: 'sandbox-1', capability: 'sandbox.run', input })

  test('a snippet without network runs unasked: no owner answer, no approval', () => {
    expect(runsUnasked(BUILTIN, 'sandbox.run', code)).toBe(true)
    expect(ownerAnswers(MOTOR_REMOTE_TOOL, call(code))).toBe(false)
  })

  test('network: true asks the owner, and a member is not left to answer it', () => {
    const networked = { ...code, network: true }
    expect(runsUnasked(BUILTIN, 'sandbox.run', networked)).toBe(false)
    expect(ownerAnswers(MOTOR_REMOTE_TOOL, call(networked))).toBe(true)
  })

  test('an oversize code is not parsed, so it has no risk and the owner is asked', () => {
    const big = { language: 'sh', code: 'a'.repeat(100_001) }
    expect(runsUnasked(BUILTIN, 'sandbox.run', big)).toBe(false)
    expect(ownerAnswers(MOTOR_REMOTE_TOOL, call(big))).toBe(true)
  })
})

describe('who answers, over a registry (P31.1.6)', () => {
  const quiet = defineNodeCapability({
    id: 'demo.note',
    version: 1,
    supports: [1],
    driver: 'demo',
    layer: 'self',
    summary: 'Write a note.',
    risk: 'write',
    approval: 'never',
    input: z.object({ text: z.string() }),
  })
  const capabilities = createNodeCapabilityRegistry([...BUILTIN_CAPABILITY_SPECS, quiet])

  test('a capability that runs without asking is never routed to the owner', () => {
    expect(
      ownerAnswers(
        MOTOR_REMOTE_TOOL,
        { node: 'n', capability: 'demo.note', input: { text: 'x' } },
        capabilities,
      ),
    ).toBe(false)
  })

  test('a spec the registry does not hold is routed to the owner', () => {
    expect(
      ownerAnswers(
        MOTOR_REMOTE_TOOL,
        { node: 'n', capability: 'demo.note', input: {} },
        createNodeCapabilityRegistry(),
      ),
    ).toBe(true)
  })
})

/**
 * What a guest's agent can do in a booted core with the built-in plugins (docs/specs/guests.md, "The session agent"):
 * the tool list it sees equals the allow-list; a public note is readable, a private one is not; calls to any other
 * tool fail; the guest actor lives exactly as long as its session.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { SessionFacts } from '@keith/host'
import { scriptedProvider } from 'eharness/testing'
import { GUEST_TOOL_ALLOWLIST } from './modules/guests/index.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'

const usage = { inputTokens: 50, outputTokens: 20 }
const publicTitle = `Open hours ${crypto.randomUUID().slice(0, 8)}`
const publicBody = `we open at nine ${crypto.randomUUID().slice(0, 8)}`
const privateTitle = `Diary ${crypto.randomUUID().slice(0, 8)}`
const privateBody = `a secret ${crypto.randomUUID().slice(0, 8)}`

let booted: BootedCore
let publicId = ''
let privateId = ''
const facts: SessionFacts = { id: 'front:owner', kind: 'front', method: 'token', elevated: true }

const asOwner = (plugin: string, operation: string, input: unknown) => {
  const op = booted.core.plugins
    .loaded()
    .find((p) => p.id === plugin)
    ?.operation(operation)
  if (op === undefined) throw new Error(`no ${plugin}.${operation}`)
  return booted.core.plugins.guard.run(op, input, { principal: { id: 'owner' }, session: facts })
}

beforeAll(async () => {
  booted = await bootCore(
    {},
    {
      definitions: [
        scriptedProvider({
          id: 'pricey',
          models: {
            cheap: [
              // turn 1: list the public notes, then answer
              { toolCalls: [{ toolName: 'notes_public_list', toolCallId: 'a', input: {} }], usage },
              { text: 'listed', usage },
              // turn 2: ask for tools a guest must not have, and for the private note through the public tool
              {
                toolCalls: [
                  { toolName: 'notes_list', toolCallId: 'b1', input: {} },
                  { toolName: 'notes_create', toolCallId: 'b2', input: { title: 'x', body: 'y' } },
                  { toolName: 'notes_get', toolCallId: 'b3', input: { id: 'x' } },
                  { toolName: 'shell_exec', toolCallId: 'b4', input: { command: 'id' } },
                  { toolName: 'memory_search', toolCallId: 'b5', input: { query: 'a' } },
                  { toolName: 'agent', toolCallId: 'b6', input: {} },
                  { toolName: 'reminders_create', toolCallId: 'b7', input: {} },
                ],
                usage,
              },
              { text: 'tried', usage },
            ],
          },
          info: { cheap: { pricing: { input: 1, output: 4 }, contextWindow: 100_000 } },
        }),
      ],
    },
  )
  const owner = booted.local.rpc
  await owner.providers.put({ providerId: 'pricey' })
  await owner.models.roles.set({ role: 'guest', ref: 'pricey:cheap' })
  await owner.admin.guests.set({ enabled: true })
  publicId = (
    (await asOwner('notes', 'create', { title: publicTitle, body: publicBody })) as { id: string }
  ).id
  privateId = (
    (await asOwner('notes', 'create', { title: privateTitle, body: privateBody })) as { id: string }
  ).id
  await asOwner('notes', 'share', { id: publicId, target: '@public' })
})
afterAll(async () => {
  await booted.stop()
})

const open = async () => {
  const r = await booted.core.guests.open({ zone: 'lan', ipHash: 'abc123def456' })
  if (!r.ok) throw new Error(`refused: ${r.block}`)
  return r.session
}

describe('the guest agent in a core with every built-in plugin', () => {
  test('the tools it sees are exactly the allow-list, and the guard shows a guest nothing more', async () => {
    const s = await open()
    const seen = (await s.session().tools()).map((t) => t.name).sort()
    expect(seen).toEqual([...GUEST_TOOL_ALLOWLIST].sort())
    // every loaded plugin's operations, as the guard would offer them to this guest's model
    const offered = (await booted.core.plugins.visibleOperations(s.sessionId, 'ai'))
      .map((o) => o.toolName)
      .sort()
    expect(offered).toEqual([...GUEST_TOOL_ALLOWLIST].sort())
    for (const name of seen)
      expect(name).not.toMatch(/shell|motor|node|memory|budget|admin|agent|task|reminders/i)
    await booted.core.guests.end(s.id, 'closed')
  })

  test("a guest lists and reads a public note, never the private one, and learns no one's name", async () => {
    const s = await open()
    const first = await s.session().send('what notes are public?').result
    expect(first.stop).toBe('complete')
    const wire = JSON.stringify(await s.session().messages())
    expect(wire).toContain(publicTitle)
    expect(wire).not.toContain(privateTitle)
    expect(wire).not.toContain(privateBody)
    expect(wire).toContain('the author')
    expect(wire).not.toMatch(/Owner/)
    // the public tool answers only for a public note
    const op = booted.core.plugins
      .loaded()
      .find((p) => p.id === 'notes')
      ?.operation('public_get')
    if (op === undefined) throw new Error('no public_get')
    const call = (id: string) =>
      booted.core.plugins.guard.run(
        op,
        { id },
        {
          principal: { id: s.sessionId },
          session: { id: s.sessionId, kind: 'front', method: null, elevated: false },
        },
      )
    expect(((await call(publicId)) as { body: string }).body).toBe(publicBody)
    await expect(call(privateId)).rejects.toThrow('not found or not permitted')
    await expect(call('does-not-exist')).rejects.toThrow('not found or not permitted')
    await booted.core.guests.end(s.id, 'closed')
  })

  test('calls to notes, shell, memory, agent and reminders tools do nothing; nothing is created', async () => {
    const s = await open()
    const before = (await asOwner('notes', 'list', {})) as { total: number }
    const result = await s.session().send('try the other tools').result
    expect(result.stop).toBe('complete')
    const wire = JSON.stringify(await s.session().messages())
    expect(wire).not.toContain(privateBody)
    for (const part of (await s.session().messages()).flatMap((m) => m.parts ?? [])) {
      const p = part as { type: string; state?: string; toolName?: string }
      if (p.type.startsWith('tool-') || p.type === 'dynamic-tool')
        expect(p.state).not.toBe('output-available')
    }
    const after = (await asOwner('notes', 'list', {})) as { total: number }
    expect(after.total).toBe(before.total)
    await booted.core.guests.end(s.id, 'closed')
  })

  test('the guest actor exists only while its session is live', async () => {
    const s = await open()
    const op = booted.core.plugins
      .loaded()
      .find((p) => p.id === 'notes')
      ?.operation('public_list')
    if (op === undefined) throw new Error('no public_list')
    const run = (principal: string) =>
      booted.core.plugins.guard.run(
        op,
        {},
        {
          principal: { id: principal },
          session: { id: principal, kind: 'front', method: null, elevated: false },
        },
      )
    expect(((await run(s.sessionId)) as { total: number }).total).toBe(1)
    await expect(run('guest:made-up')).rejects.toThrow('not found or not permitted')
    await booted.core.guests.end(s.id, 'closed')
    await expect(run(s.sessionId)).rejects.toThrow('not found or not permitted')
  })
})

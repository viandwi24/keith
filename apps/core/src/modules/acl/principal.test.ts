/**
 * Confused deputy (ADR-0015, decision 8; docs/specs/acl.md): a tool checks the ACL for the principal of the turn
 * that asked, read from the database at the moment it runs. Scripted models over the SQLite adapters.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { defineKinds } from '@keith/acl'
import { sqliteAcl, sqliteInbox, sqliteMessages, sqliteState } from '@keith/db'
import { tool } from 'ai'
import { defineHarnessAgent, definePlugin, type HarnessAgent } from 'eharness'
import { subagent } from 'eharness/subagent'
import { scriptedModel } from 'eharness/testing'
import { z } from 'zod'
import { frontSessionId, frontSessionOptions, principalOf } from '../../platform/sessions.ts'
import { cleanup, harness } from '../../testing/auth-harness.ts'
import { createAclActors } from './actors.ts'
import { ACL_CHANGING_TOOLS, aclGuard, changesAccess } from './guard.ts'

afterEach(cleanup)
const silent = { debug() {}, info() {}, warn() {}, error() {} }
// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>

interface Seen {
  where: string
  kind: string | undefined
  principal: string | undefined
  actor: string | undefined
  id: string
  ok: boolean
}

async function world() {
  const h = harness()
  const owner = await h.people.owner()
  const ana = await h.people.add({ username: 'ana' }, { actor: 'owner', via: 'local' })
  const bob = await h.people.add({ username: 'bob' }, { actor: 'owner', via: 'local' })
  const acl = sqliteAcl(h.sqlite, { kinds: defineKinds({ note: { class: 'leaf' } }) })
  acl.createResource({ kind: 'note', id: 'ana-note', ownerId: ana.id })
  acl.createResource({ kind: 'note', id: 'owner-note', ownerId: owner?.id ?? 'owner' })
  const actors = createAclActors({ people: h.people })
  const seen: Seen[] = []
  /** A tool that reads a note the way a plugin must: as the principal of the turn, resolved now. */
  const probe = (where: string) =>
    definePlugin({
      name: `probe-${where}`,
      setup: () => ({
        tools: {
          read_note: (ctx) =>
            tool({
              description: 'read a note',
              inputSchema: z.object({ id: z.string() }),
              execute: async ({ id }) => {
                const actor = await actors.of(ctx.principal)
                const ok = actor !== undefined && acl.check(actor, 'note', id, 4).allowed
                seen.push({
                  where,
                  kind: ctx.turn?.kind,
                  principal: ctx.principal?.id,
                  actor: actor?.id,
                  id,
                  ok,
                })
                return ok ? `READ ${id}` : 'not found'
              },
            }),
        },
      }),
    })
  return { h, acl, ana, bob, owner, actors, seen, probe }
}

const read = (id: string, n = 1) => ({ toolName: 'read_note', toolCallId: `r${n}`, input: { id } })
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(5)
  }
}

function storageOf(sqlite: Parameters<typeof sqliteInbox>[0]) {
  return {
    messages: sqliteMessages(sqlite),
    state: sqliteState(sqlite),
    inbox: sqliteInbox(sqlite),
  }
}

describe('the actor resolver', () => {
  test('reads status and role now, and ignores role and groups carried in the principal', async () => {
    const w = await world()
    expect(await w.actors.of({ id: w.ana.id, role: 'owner', groups: ['crew'] })).toEqual({
      kind: 'user',
      id: w.ana.id,
      role: 'member',
    })
    expect((await w.actors.of({ id: 'owner' }))?.role).toBe('owner')
    expect(await w.actors.of(undefined)).toBeUndefined()
    expect(await w.actors.of({ id: 'ana' })).toBeUndefined() // a username is not a principal id
    expect(await w.actors.of({ id: 'guest:g1' })).toBeUndefined()
    await w.h.people.suspend(w.ana.id, { actor: 'owner', via: 'local' })
    expect(await w.actors.of({ id: w.ana.id })).toBeUndefined()
    await w.h.people.reactivate(w.ana.id, { actor: 'owner', via: 'local' })
    expect((await w.actors.of({ id: w.ana.id }))?.id).toBe(w.ana.id)
    await w.h.people.remove(w.ana.id, { actor: 'owner', via: 'local' })
    expect(await w.actors.of({ id: w.ana.id })).toBeUndefined()
  })
})

describe('turns run as the person who asked', () => {
  test('a parked turn answered by the owner still checks as the asker', async () => {
    const w = await world()
    const approve = definePlugin({
      name: 'ask',
      setup: () => ({
        hooks: {
          'tool.approve': (_ctx, e) =>
            e.toolName === 'read_note'
              ? { type: 'user-approval' as const, reason: 'ask' }
              : undefined,
        },
      }),
    })
    const agent = defineHarnessAgent({
      id: 'front',
      model: scriptedModel([
        { toolCalls: [read('ana-note', 1), read('owner-note', 2)] },
        { text: 'done' },
      ]),
      contextWindow: 100_000,
      plugins: [w.probe('front'), approve] as never,
    }) as Agent
    const id = frontSessionId(w.ana.id, 0)
    const session = agent.session(id, frontSessionOptions(id))
    await session.send('read both').result
    const pending = await agent.peek(id).pending()
    expect(pending?.approvals.length).toBe(2)
    await session.respond({
      approvals: (pending?.approvals ?? []).map((a) => ({
        id: a.approvalId,
        approved: true,
        actor: { id: 'owner' },
      })),
    }).result
    expect(w.seen.map((s) => [s.id, s.principal, s.actor, s.ok]).sort()).toEqual([
      ['ana-note', w.ana.id, w.ana.id, true],
      ['owner-note', w.ana.id, w.ana.id, false],
    ])
    await agent.close()
  })

  test('a wake turn checks as the person whose session it wakes', async () => {
    const w = await world()
    const agent = defineHarnessAgent({
      id: 'front',
      model: scriptedModel([{ toolCalls: [read('owner-note')] }, { text: 'done' }]),
      contextWindow: 100_000,
      plugins: [w.probe('front')] as never,
    }) as Agent
    const id = frontSessionId(w.bob.id, 0)
    const session = agent.session(id, frontSessionOptions(id))
    const woke = await session.inject(
      'eh.event',
      { name: 'subagent', text: 'Background subagent finished.', data: { taskId: 't1' } },
      { deliver: 'next-turn', wake: true },
    )
    await woke.run?.result
    expect(w.seen.map((s) => [s.kind, s.principal, s.actor, s.ok])).toEqual([
      ['wake', w.bob.id, w.bob.id, false],
    ])
    await agent.close()
  })

  test('a subagent and the wake turn that delivers its report check as the asker', async () => {
    const w = await world()
    const storage = storageOf(w.h.sqlite)
    const holder: { lead?: Agent; worker?: Agent } = {}
    const worker = defineHarnessAgent({
      id: 'worker',
      model: scriptedModel([{ toolCalls: [read('ana-note')] }, { text: 'Report: read it.' }]),
      contextWindow: 100_000,
      storage,
      logger: silent,
      inbox: { pollMs: 20 },
      plugins: [
        w.probe('worker'),
        subagent({
          agents: {},
          approvals: 'park',
          parentAgent: () => holder.lead as Agent,
          selfAgent: () => holder.worker as Agent,
          onPark: 'notice',
          messageTool: false,
        }),
      ] as never,
    }) as Agent
    holder.worker = worker
    const lead = defineHarnessAgent({
      id: 'front',
      model: scriptedModel([
        {
          toolCalls: [
            {
              toolName: 'agent',
              toolCallId: 'c1',
              input: {
                subagent_type: 'cortex.research',
                description: 'read it',
                prompt: 'Read the note.',
                run_in_background: true,
              },
            },
          ],
        },
        { text: 'On it.' },
        { toolCalls: [read('owner-note')] },
        { text: 'The report arrived.' },
      ]),
      contextWindow: 100_000,
      storage,
      logger: silent,
      inbox: { pollMs: 20 },
      plugins: [
        w.probe('lead'),
        subagent({
          agents: { 'cortex.research': { agent: worker, description: 'Reads.' } },
          selfAgent: () => holder.lead as Agent,
          approvals: 'park',
          background: { default: true, timeoutMs: 3_600_000 },
          maxDepth: 1,
          maxConcurrent: 3,
          messageTool: false,
        }),
      ] as never,
    }) as Agent
    holder.lead = lead
    const id = frontSessionId(w.ana.id, 0)
    await lead.session(id, frontSessionOptions(id)).send('delegate').result
    await until('worker and wake both ran', () =>
      ['worker', 'lead'].every((where) => w.seen.some((s) => s.where === where)),
    )
    const worked = w.seen.find((s) => s.where === 'worker')
    expect(worked).toMatchObject({ principal: w.ana.id, actor: w.ana.id, ok: true })
    const woken = w.seen.find((s) => s.where === 'lead')
    expect(woken).toMatchObject({ kind: 'wake', principal: w.ana.id, actor: w.ana.id, ok: false })
    expect(w.seen.every((s) => s.actor === w.ana.id)).toBe(true)
    await lead.close()
    await worker.close()
  })

  test('a person suspended after their turn was queued is refused when it runs', async () => {
    const w = await world()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let started!: () => void
    const running = new Promise<void>((r) => {
      started = r
    })
    const hold = definePlugin({
      name: 'hold',
      setup: () => ({
        tools: {
          hold: tool({
            description: 'hold',
            inputSchema: z.object({}),
            execute: async () => {
              started()
              await gate
              return 'held'
            },
          }),
        },
      }),
    })
    const agent = defineHarnessAgent({
      id: 'front',
      model: scriptedModel([
        { toolCalls: [{ toolName: 'hold', toolCallId: 'h1', input: {} }] },
        { text: 'first done' },
        { toolCalls: [read('ana-note')] },
        { text: 'second done' },
      ]),
      contextWindow: 100_000,
      storage: storageOf(w.h.sqlite),
      logger: silent,
      inbox: { pollMs: 20 },
      plugins: [w.probe('front'), hold] as never,
    }) as Agent
    const id = frontSessionId(w.ana.id, 0)
    const session = agent.session(id, frontSessionOptions(id))
    const first = session.send('first').result
    await running
    await session.enqueue('second', { principal: principalOf(w.ana.id) })
    // the person is suspended while the second turn waits in the inbox
    await w.h.people.suspend(w.ana.id, { actor: 'owner', via: 'local' })
    release()
    await first
    await until('the queued turn ran', () => w.seen.length > 0)
    expect(w.seen[0]).toMatchObject({ principal: w.ana.id, actor: undefined, ok: false })
    await agent.close()
  })
})

describe('ACL-changing tools always ask', () => {
  test('the guard asks by tool name only, for every acl_ tool, and never approves', async () => {
    for (const name of ACL_CHANGING_TOOLS) expect(changesAccess(name)).toBe(true)
    expect(changesAccess('acl_anything_new')).toBe(true)
    expect(changesAccess('read_note')).toBe(false)
    expect(changesAccess('note_acl')).toBe(false)
  })

  test('an acl_share tool parks for approval even where the policy approves everything', async () => {
    const w = await world()
    let ran = 0
    const share = definePlugin({
      name: 'share',
      setup: () => ({
        tools: {
          acl_share: tool({
            description: 'share a note',
            inputSchema: z.object({ id: z.string() }),
            execute: () => {
              ran++
              return 'shared'
            },
          }),
        },
      }),
    })
    const agent = defineHarnessAgent({
      id: 'front',
      model: scriptedModel([
        { toolCalls: [{ toolName: 'acl_share', toolCallId: 's1', input: { id: 'ana-note' } }] },
        { text: 'ok' },
      ]),
      contextWindow: 100_000,
      approval: {
        risk: {
          read: 'approved',
          write: 'approved',
          external: 'approved',
          destructive: 'approved',
        },
      },
      plugins: [share, aclGuard()] as never,
    }) as Agent
    const id = frontSessionId(w.ana.id, 0)
    const session = agent.session(id, frontSessionOptions(id))
    await session.send('share it').result
    expect(ran).toBe(0)
    expect((await agent.peek(id).pending())?.approvals.length).toBe(1)
    await agent.close()
  })
})

/**
 * P9 step 4: people are isolated. Memory per person, the activity feed per person, budget caps per
 * person, recovery for every person, and an ownership transfer that moves the owner's role only.
 * Real core, scripted models, two people (the owner and `ana`).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createKeithClient, type KeithClient } from '@keith/client'
import { interruptedTurn } from 'eharness/client'
import {
  boot,
  cleanup,
  connect,
  FAST,
  newDir,
  send,
  spawn,
  stop,
  tasksOf,
  textOf,
} from './testing/core-harness.ts'
import { issueOwnerToken } from './testing/owner-token.ts'
import {
  answerApproval,
  type Booted,
  baseUrl,
  scenario,
  shell,
  waitForAttention,
} from './testing/scenario-harness.ts'
import { createGate, testProvider } from './testing/scripted-providers.ts'
import { until } from './testing/wait.ts'

afterAll(cleanup)

const configOf = (dataDir: string) => ({ dataDir, dbFile: `${dataDir}/keith.db` }) as never

/** Add a member and a live (stepped up) credential for them; no password hashing involved. */
async function addMember(r: Booted, dataDir: string, username: string) {
  const person = await r.client.rpc.admin.people.add({ username })
  const token = await issueOwnerToken(configOf(dataDir), username, { personId: person.id })
  return { id: person.id, token, client: createKeithClient({ baseUrl: baseUrl(r), token }) }
}

const say = async (client: KeithClient, text: string, session: string) => {
  for await (const _ of client.reply(text, session)) {
    // drain: the stream ends with the turn
  }
}
const eventsOf = async (client: KeithClient) =>
  (await client.harness.activity.page({ after: 0, limit: 500 })).events
const call = (toolName: string, toolCallId: string, input: unknown) => ({
  toolCalls: [{ toolName, toolCallId, input }],
})

describe('memory per person', () => {
  test('each person has their own folder; neither reads or writes the other; a worker reads its person read-only', async () => {
    let ana = ''
    const s = await scenario({
      front: [
        call('memory_create', 'o1', {
          path: '/memories/owner/profile.md',
          file_text: 'Owner is vegetarian\n',
        }),
        { text: 'noted' },
        () =>
          call('memory_create', 'a1', {
            path: `/memories/${ana}/profile.md`,
            file_text: 'Ana plays jazz\n',
          }),
        call('memory_view', 'a2', { path: '/memories/owner' }),
        call('memory_create', 'a3', { path: '/memories/owner/hack.md', file_text: 'pwned\n' }),
        { text: 'done' },
        { toolCalls: [spawn('a4', 'look at memory')] },
        { text: 'on it' },
        { text: 'worker finished' },
        { text: 'hello owner' },
      ] as never,
      worker: [
        () => call('memory_view', 'w1', { path: `/memories/${ana}` }),
        call('memory_view', 'w2', { path: '/memories/owner' }),
        () => call('memory_create', 'w3', { path: `/memories/${ana}/w.md`, file_text: 'x\n' }),
        { text: 'report: ana likes jazz' },
      ] as never,
    })
    const member = await addMember(s.r, s.dataDir, 'ana')
    ana = member.id
    const anaFront = `front:${ana}`
    const prompts = () => (s.front.models.get('f')?.prompts ?? []).map((p) => JSON.stringify(p))

    await send(s.r.client, 'remember I am vegetarian')
    await say(member.client, 'remember I play jazz', anaFront)
    expect(readFileSync(join(s.dataDir, 'memory', 'owner', 'profile.md'), 'utf8')).toContain(
      'vegetarian',
    )
    expect(readFileSync(join(s.dataDir, 'memory', ana, 'profile.md'), 'utf8')).toContain('jazz')
    // her write into the owner's root and her look at it were refused
    expect(existsSync(join(s.dataDir, 'memory', 'owner', 'hack.md'))).toBe(false)
    const forAna = prompts()
    expect(forAna[2]).toContain(`/memories/${ana}/`)
    expect(forAna[2]).toContain('username ana')
    expect(forAna[2]).not.toContain('vegetarian')
    expect(forAna[4]).toContain('outside the memory roots')
    expect(forAna[5]).toContain('outside the memory roots')

    // her worker reads her memory only, and cannot write it
    await say(member.client, 'research my taste', anaFront)
    await until(
      'her task done',
      () => tasksOf(member.client),
      (l) => l[0]?.status === 'done',
    )
    const worker = s.workerPrompts()
    expect(worker[1]).toContain('jazz')
    expect(worker[2]).toContain('outside the memory roots')
    expect(worker[3]).toContain('read-only')
    expect(worker.join('')).not.toContain('vegetarian')
    expect(existsSync(join(s.dataDir, 'memory', ana, 'w.md'))).toBe(false)

    // the owner's next turn pins the owner's profile and never shows Ana's
    await until(
      'her session idle',
      async () => !(await member.client.harness.sessions.get(anaFront)).running,
    )
    await send(s.r.client, 'hi')
    const owner = prompts().at(-1) ?? ''
    expect(owner).toContain('vegetarian')
    expect(owner).not.toContain('jazz')
    expect(owner).toContain('/memories/owner/')
  })
})

describe('activity feed per person', () => {
  test('a person sees their own sessions; the owner also sees system events and owner-routed waits, no previews', async () => {
    const s = await scenario({
      nodes: [{ name: 'laptop-e' }],
      front: [
        { text: 'owner ok' },
        {
          toolCalls: [
            {
              toolName: 'agent',
              toolCallId: 'c1',
              input: {
                subagent_type: 'cortex.general',
                description: 'machine task',
                prompt: 'run it',
                run_in_background: true,
              },
            },
          ],
        },
        { text: 'on it' },
        { text: 'worker finished' },
      ],
      worker: [{ toolCalls: [shell('m1', 'laptop-e', 'echo hi')] }, { text: 'done' }],
    })
    const ana = await addMember(s.r, s.dataDir, 'ana')
    await send(s.r.client, 'owner secret plan')
    await s.r.client.rpc.budget.set({ limitUsd: 7 })
    await say(ana.client, 'ana private words', `front:${ana.id}`)
    const item = (await waitForAttention(s.r))[0]
    await answerApproval(s.r, item as never, { approved: true })
    await until(
      'her task done',
      () => tasksOf(ana.client),
      (l) => l[0]?.status === 'done',
    )

    const owner = await eventsOf(s.r.client)
    const ours = JSON.stringify(owner)
    expect(ours).toContain('owner secret plan')
    expect(ours).not.toContain('ana private words')
    expect(owner.some((e) => e.type === 'budget-changed')).toBe(true)
    expect(owner.some((e) => e.type === 'node-changed')).toBe(true)
    // only the owner-routed wait of her worker reaches the owner: no turns, tasks or memory of hers
    const hers = owner.filter((e) => (e.sessionId ?? '').startsWith(`front:${ana.id}`))
    expect(hers.length).toBeGreaterThan(0)
    expect(new Set(hers.map((e) => e.type))).toEqual(new Set(['brain.amygdala.wait']))
    expect(hers[0]?.payload).toMatchObject({ toolName: 'motor_remote', personId: ana.id })

    const mine = await eventsOf(ana.client)
    const theirs = JSON.stringify(mine)
    expect(theirs).toContain('ana private words')
    expect(theirs).not.toContain('owner secret plan')
    expect(mine.some((e) => e.type === 'budget-changed')).toBe(false)
    // nodes are Keith's body, not a person's data: every person sees node-changed (ADR-0027 section 9)
    expect(mine.some((e) => e.type === 'node-changed')).toBe(true)
    expect(
      mine
        .filter((e) => e.type !== 'node-changed')
        .every((e) => (e.sessionId ?? '').startsWith(`front:${ana.id}`)),
    ).toBe(true)
    expect(mine.some((e) => e.type === 'task-changed')).toBe(true)
  })
})

describe('budget per person', () => {
  test("a cap refuses one person's turn while the owner still works; the ledger records each person", async () => {
    const s = await scenario({
      pricing: { input: 1, output: 1 },
      front: [{ text: 'owner one' }, { text: 'owner two' }],
    })
    const ana = await addMember(s.r, s.dataDir, 'ana')
    await send(s.r.client, 'first')
    const capped = await s.r.client.rpc.budget.setPersonCap({ person: 'ana', usd: 0 })
    expect(capped).toMatchObject({ personId: ana.id, username: 'ana', limitUsd: 0 })
    await say(ana.client, 'my turn', `front:${ana.id}`)
    const notices = JSON.stringify(
      (await ana.client.harness.sessions.messages(`front:${ana.id}`, { limit: 50 })).messages,
    )
    expect(notices).toContain('Your monthly cost cap (0 USD')
    // the owner is not capped and keeps working
    await send(s.r.client, 'second')
    expect(s.front.models.get('f')?.calls.length).toBe(2)

    const all = await s.r.client.rpc.budget.get()
    expect(all.scope).toBe('owner')
    const rows = Object.fromEntries((all.people ?? []).map((p) => [p.username, p]))
    expect(rows.owner?.spentUsd).toBeGreaterThan(0)
    expect(rows.owner?.limitUsd).toBeNull()
    expect(rows.ana).toMatchObject({ limitUsd: 0, spentUsd: 0 })
    // she sees only her own spend and cap, and cannot change it
    const own = await ana.client.rpc.budget.get()
    expect(own).toMatchObject({ scope: `person:${ana.id}`, limitUsd: 0, remainingUsd: 0 })
    expect(own.people).toBeUndefined()
    await expect(ana.client.rpc.budget.setPersonCap({ person: 'ana', usd: null })).rejects.toThrow()
    // removing the cap lets her turns through again (the global limit still applies)
    await s.r.client.rpc.budget.setPersonCap({ person: 'ana', usd: null })
    expect((await ana.client.rpc.budget.get()).limitUsd).toBeNull()
  })
})

describe('every person is recovered', () => {
  test('a graceful stop marks the running turn of each person interrupted', async () => {
    const config = newDir()
    const gate = createGate()
    const defs = (text: string, g?: ReturnType<typeof createGate>) =>
      [
        testProvider({
          id: 'front-p',
          models: { f: [{ text }, { text }] },
          ...(g === undefined ? {} : { gate: g }),
        }),
        testProvider({ id: 'cortex-p', models: { w: [{ text: 'x' }] } }),
      ] as never[]
    const a = await boot(config, defs('never finishes', gate))
    await connect(a.client)
    const person = await a.client.rpc.admin.people.add({ username: 'ana' })
    const token = await issueOwnerToken(config, 'ana', { personId: person.id })
    const ana = createKeithClient({ baseUrl: a.server.url.href, token })
    const running = [send(a.client, 'one'), say(ana, 'two', `front:${person.id}`)].map((p) =>
      p.catch(() => undefined),
    )
    await gate.whenStarted(2)
    await stop(a)
    gate.release()
    await Promise.all(running)

    const b = await boot(config, defs('back'), a.token, FAST)
    const anaB = createKeithClient({ baseUrl: b.server.url.href, token })
    for (const [client, id] of [
      [b.client, 'front:owner'],
      [anaB, `front:${person.id}`],
    ] as const) {
      const messages = await until(
        `interrupted notice of ${id}`,
        async () => (await client.harness.sessions.messages(id, { limit: 100 })).messages,
        (list) => JSON.stringify(list).includes('EH_TURN_INTERRUPTED'),
      )
      expect(interruptedTurn(messages)).toBeDefined()
      expect((await client.harness.sessions.get(id)).running).toBe(false)
    }
    await stop(b)
  })
})

describe('transfer of ownership', () => {
  test("the new owner's front, memory folder and system events follow the role; the former owner keeps theirs", async () => {
    let ana = ''
    const s = await scenario({
      front: [
        () =>
          call('memory_create', 'a1', {
            path: `/memories/${ana}/profile.md`,
            file_text: 'Ana owns Keith now\n',
          }),
        { text: 'noted' },
        { text: 'former owner here' },
      ] as never,
    })
    const member = await addMember(s.r, s.dataDir, 'ana')
    ana = member.id
    await s.r.client.rpc.admin.people.setPin({ person: 'ana', pin: '730416' })
    await s.r.client.rpc.admin.people.transferOwner({ person: 'ana' })
    // transfer signs both out: new credentials, the new owner is stepped up
    const newOwner = createKeithClient({
      baseUrl: baseUrl(s.r),
      token: await issueOwnerToken(configOf(s.dataDir), 'new', { personId: ana }),
    })
    const former = createKeithClient({
      baseUrl: baseUrl(s.r),
      token: await issueOwnerToken(configOf(s.dataDir), 'former', { personId: 'owner' }),
    })
    expect((await newOwner.rpc.auth.whoami()).role).toBe('owner')
    expect((await former.rpc.auth.whoami()).role).toBe('member')

    await say(newOwner, 'remember this', `front:${ana}`)
    expect(readFileSync(join(s.dataDir, 'memory', ana, 'profile.md'), 'utf8')).toContain('Ana owns')
    expect(existsSync(join(s.dataDir, 'memory', 'owner', 'profile.md'))).toBe(false)
    await say(former, 'still me', 'front:owner')
    expect(
      textOf(
        (await former.harness.sessions.messages('front:owner', { limit: 20 })).messages.at(-1),
      ),
    ).toBe('former owner here')

    // system events follow the role
    await newOwner.rpc.budget.set({ limitUsd: 9 })
    expect((await eventsOf(newOwner)).some((e) => e.type === 'budget-changed')).toBe(true)
    expect((await eventsOf(former)).some((e) => e.type === 'budget-changed')).toBe(false)
  })
})

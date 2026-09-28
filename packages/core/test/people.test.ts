// Phase 5 integration (P5-I1): `keith person` on the real home next to a running core (D9). An
// added person signs up through `POST /v1/auth/invite`, a tier change reaches their next turn
// without a restart, and `keith person remove` with Keith stopped deletes what ADR-0018 lists.

import { afterEach, describe, expect, test } from 'bun:test'
import type { LoginResponse } from '@keith/protocol'
import { fakeText, fakeToolCall } from '@keith/sdk/testing'
import { type CliIo, runCli } from '../src/cli/index.ts'
import { hashInviteCode } from '../src/cli/person.ts'
import { hashToken } from '../src/server/auth.ts'
import type { MemoryId, MessageId, PersonId, ThreadId } from '../src/shared/types.ts'
import {
  acceptInvite,
  afterTool,
  attach,
  attachOwner,
  type Cleanups,
  codeFromLink,
  createWorld,
  frameThread,
  greet,
  lastUser,
  type Member,
  say,
  settle,
  signUp,
  startKeith,
  type World,
  waitFrame,
} from './people-helpers.ts'

const cleanups: Cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function person(world: World, args: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = []
  const io: CliIo = {
    env: { KEITH_HOME: world.home.dir },
    out: (line) => lines.push(line),
    err: (line) => lines.push(`ERR ${line}`),
    clock: world.clock,
  }
  const code = await runCli(['person', ...args], io)
  return { code, lines }
}

function toolNames(req: { tools?: { name: string }[] | undefined } | undefined): string[] {
  return (req?.tools ?? []).map((t) => t.name)
}

describe('keith person next to the real core', () => {
  test('person add prints a link whose code signs Pepper in through POST /v1/auth/invite', async () => {
    const world = await createWorld(cleanups)
    const keith = await startKeith(world, cleanups)

    const added = await person(world, ['add', 'Pepper'])
    expect({ code: added.code, lines: added.lines }).toMatchObject({ code: 0 })
    const code = codeFromLink(added.lines.join('\n'))
    expect(added.lines.join('\n')).toContain(`/#invite=${code}`)
    // The CLI stores what the endpoint looks up (one shared hash, shared/hash.ts).
    expect(hashInviteCode(code)).toBe(hashToken(code))
    const pepper = await keith.repos.persons.findByName('pepper')
    expect(pepper).toMatchObject({ name: 'Pepper', tier: 'member', username: null, passwordHash: null })
    expect(await keith.repos.inviteLinks.get(hashInviteCode(code))).toMatchObject({
      personId: pepper?.id,
      usedAt: null,
    })

    const res = await acceptInvite(keith.url, { code, username: 'pepper', password: 'orchids-42' })
    expect(res.status).toBe(200)
    const login = res.body as LoginResponse
    expect(login.person).toMatchObject({ id: pepper?.id, name: 'Pepper', tier: 'member' })
    const me = await fetch(`${keith.url}/v1/me`, { headers: { authorization: `Bearer ${login.token}` } })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { person?: { name: string } }).person?.name ?? '').toBe('Pepper')

    // She lands in the main thread `keith person add` made.
    const { main } = await attach(keith, login.token, cleanups)
    expect(main).toBe((await keith.repos.threads.getBySlug(pepper?.id as PersonId, 'main'))?.id as ThreadId)

    // Single use: the same code again is 401.
    const again = await acceptInvite(keith.url, { code, username: 'pepper2', password: 'orchids-42' })
    expect(again.status).toBe(401)
  })

  test('person tier to guest while Keith runs takes effect on her next turn', async () => {
    const world = await createWorld(cleanups)
    const keith = await startKeith(world, cleanups)
    const pepper = await signUp(keith, world, cleanups, 'Pepper')
    const chat = world.fake.chat
    chat.route({
      name: 'ask',
      when: (r) => lastUser(r) === 'What can you do?',
      reply: () => fakeText('A lot.'),
      times: 2,
    })

    await greet(keith, pepper)
    say(pepper, pepper.main, 'What can you do?')
    await waitFrame(
      pepper.client,
      'message.completed',
      (f) => (f.data.message as { content: string }).content === 'A lot.',
    )
    await settle(keith)
    const asMember = toolNames(chat.requests.at(-1))
    for (const name of ['reminder.set', 'thread.start_group', 'thread.invite', 'relay.send', 'thread.join']) {
      expect(asMember).toContain(name)
    }

    const changed = await person(world, ['tier', 'Pepper', 'guest'])
    expect(changed.code).toBe(0)
    expect((await keith.repos.persons.get(pepper.id))?.tier).toBe('guest')

    say(pepper, pepper.main, 'What can you do?')
    await waitFrame(
      pepper.client,
      'message.completed',
      (f) => (f.data.message as { content: string }).content === 'A lot.',
    )
    await settle(keith)
    const asGuest = toolNames(chat.requests.at(-1))
    for (const name of ['reminder.set', 'thread.start_group', 'thread.invite'])
      expect(asGuest).not.toContain(name)
    for (const name of ['relay.send', 'thread.join', 'thread.leave', 'memory.remember'])
      expect(asGuest).toContain(name)
    expect(chat.unmatched).toEqual([])
  })

  test('person remove with Keith stopped deletes her data; Tony still opens the group', async () => {
    const world = await createWorld(cleanups, '\n[mind.group]\nautoJoin = true\n')
    const first = await startKeith(world, cleanups)
    // What she writes and what is remembered about her, to check after the removal.
    const memoryIds: MemoryId[] = []
    const messageIds: MessageId[] = []
    first.events.on('memory.written', (e) => {
      memoryIds.push(e.data.memoryId)
    })
    first.events.on('thread.message_added', (e) => {
      messageIds.push(e.data.messageId)
    })
    const tony = await attachOwner(first, world, cleanups)
    const pepper: Member = await signUp(first, world, cleanups, 'Pepper')
    await greet(first, pepper)
    const chat = world.fake.chat

    // Her direct thread holds a memory about her.
    chat.route(
      {
        name: 'remember',
        when: (r) => lastUser(r) === 'I love orchids.',
        reply: () => [fakeToolCall('memory.remember', { content: 'Pepper loves orchids.' })],
      },
      { name: 'remembered', when: (r) => afterTool(r, 'memory.remember'), reply: () => fakeText('Noted.') },
    )
    say(pepper, pepper.main, 'I love orchids.')
    await waitFrame(
      pepper.client,
      'message.completed',
      (f) => (f.data.message as { content: string }).content === 'Noted.',
    )
    await settle(first)
    const [memoryId] = memoryIds
    expect((await first.repos.memories.get(memoryId as MemoryId))?.subjectPersonId).toBe(pepper.id)

    // A group Tony starts; Pepper is added at once (autoJoin) and says something in it.
    chat.route(
      {
        name: 'start',
        when: (r) => lastUser(r) === 'Start Mission with Pepper.',
        reply: () => [fakeToolCall('thread.start_group', { participants: ['Pepper'], title: 'Mission' })],
      },
      { name: 'started', when: (r) => afterTool(r, 'thread.start_group'), reply: () => fakeText('Started.') },
      {
        name: 'added',
        when: (r) => lastUser(r) === null && r.system.includes('(invitation from Tony)'),
        reply: () => fakeText('Tony added you to Mission.'),
      },
      {
        name: 'noted',
        when: (r) => lastUser(r) === 'Tony: Keith, note the time.',
        reply: () => fakeText('Six it is.'),
      },
    )
    say(tony, tony.main, 'Start Mission with Pepper.')
    const updated = await waitFrame(pepper.client, 'thread.updated')
    const group = (updated.data.thread as { id: ThreadId }).id
    await waitFrame(
      pepper.client,
      'message.completed',
      (f) =>
        frameThread(f) === pepper.main &&
        (f.data.message as { content: string }).content === 'Tony added you to Mission.',
    )
    await settle(first)
    for (const m of [tony, pepper]) {
      const id = m.client.send('thread.open', { threadId: group })
      await waitFrame(m.client, 'thread.opened', (f) => f.re === id)
    }
    say(pepper, group, 'Tony, see you at six.')
    await settle(first)
    say(tony, group, 'Keith, note the time.')
    await waitFrame(tony.client, 'message.completed', (f) => frameThread(f) === group)
    await settle(first)
    const records = await Promise.all(messageIds.map((id) => first.repos.messages.get(id)))
    const hers = records.filter((m) => m?.authorPersonId === pepper.id).map((m) => m?.id as MessageId)
    expect(records.filter((m) => m?.threadId === group && m.authorPersonId === pepper.id)).toHaveLength(1)
    expect(records.filter((m) => m?.threadId === pepper.main).length).toBeGreaterThan(0)

    // While Keith runs, remove refuses (it needs the home lock).
    const refused = await person(world, ['remove', 'Pepper', '--yes'])
    expect(refused.code).toBe(1)
    expect(await first.repos.persons.get(pepper.id)).not.toBeNull()

    await tony.client.close()
    await pepper.client.close()
    await first.stop()
    const removed = await person(world, ['remove', 'Pepper', '--yes'])
    expect(removed.code).toBe(0)

    const second = await startKeith(world, cleanups)
    expect(await second.repos.persons.get(pepper.id)).toBeNull()
    expect(await second.repos.threads.get(pepper.main)).toBeNull()
    expect(await second.repos.memories.get(memoryId as MemoryId)).toBeNull()
    for (const id of hers) expect(await second.repos.messages.get(id)).toBeNull()
    expect(await second.repos.messages.lastSeq(pepper.main)).toBe(0)
    expect(await second.repos.threads.formerParticipants(group)).toEqual([])
    expect(await second.repos.authTokens.get(hashToken(pepper.token))).toBeNull()
    expect(await second.repos.threads.listForPerson(pepper.id)).toEqual([])

    // Tony's group still opens, without her line.
    const again = await attachOwner(second, world, cleanups)
    const openId = again.client.send('thread.open', { threadId: group })
    const opened = await waitFrame(again.client, 'thread.opened', (f) => f.re === openId)
    const thread = opened.data.thread as { participants: { id: string }[]; formerParticipants?: unknown[] }
    expect(thread.participants.map((p) => p.id)).toEqual([world.owner])
    const contents = (opened.data.messages as { content: string }[]).map((m) => m.content)
    expect(contents).toEqual(['Keith, note the time.', 'Six it is.'])
    expect(chat.unmatched).toEqual([])
  })
})

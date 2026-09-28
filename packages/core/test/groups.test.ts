// Phase 5 integration (P5-I1): a group thread on the real core. Tony's model starts it, Pepper and
// Rhodey get invitation deliveries with Join / Decline, a click joins them, addressing decides
// which lines get a turn (rules, then `fake:utility`), and a leaver loses the thread until he is
// invited back (ADR-0017, S-6).

import { afterEach, describe, expect, test } from 'bun:test'
import type { LlmRequest } from '@keith/sdk'
import { fakeText, fakeToolCall } from '@keith/sdk/testing'
import type { Keith } from '../src/bootstrap.ts'
import { INVITATION_ACTIONS_ID } from '../src/mind/groups.ts'
import type { ThreadId } from '../src/shared/types.ts'
import {
  afterTool,
  attachOwner,
  type Cleanups,
  createWorld,
  frameThread,
  greet,
  lastUser,
  type Member,
  type RoutedChat,
  say,
  settle,
  signUp,
  startKeith,
  waitFrame,
} from './people-helpers.ts'

const cleanups: Cleanups = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

type ThreadDtoLike = {
  id: string
  kind: string
  title: string
  purpose?: string
  participants: { id: string; name: string }[]
  formerParticipants?: { id: string; name: string }[]
}

function scriptMembership(chat: RoutedChat, group: () => ThreadId | null): void {
  chat.route(
    {
      name: 'invitation',
      when: (r) => lastUser(r) === null && r.system.includes('(invitation from Tony)'),
      reply: () => fakeText('Tony invites you to Mission. Want to join?'),
      times: 10,
    },
    {
      name: 'join',
      when: (r) => lastUser(r) === '(clicked: Join)',
      reply: () => [fakeToolCall('thread.join', { threadId: group() })],
      times: 10,
    },
    {
      name: 'joined',
      when: (r) => afterTool(r, 'thread.join'),
      reply: () => fakeText('You are in Mission now.'),
      times: 10,
    },
  )
}

/** Waits for the invitation in the member's main thread and clicks Join on it. */
async function clickJoin(member: Member): Promise<void> {
  const invitation = await waitFrame(
    member.client,
    'message.completed',
    (f) =>
      frameThread(f) === member.main &&
      (f.data.message as { content: string }).content === 'Tony invites you to Mission. Want to join?',
  )
  const messageId = (invitation.data.message as { id: string }).id
  // The card travels on the message (this node has no ui.render@1).
  const ui = JSON.stringify((invitation.data.message as { ui?: unknown }).ui)
  expect(ui).toContain('"label":"Join"')
  expect(ui).toContain('"label":"Decline"')
  member.client.send('ui.action', {
    threadId: member.main,
    messageId,
    blockId: INVITATION_ACTIONS_ID,
    actionId: 'join',
  })
  await waitFrame(
    member.client,
    'message.completed',
    (f) =>
      frameThread(f) === member.main &&
      (f.data.message as { content: string }).content === 'You are in Mission now.',
  )
}

async function openGroup(member: Member, group: ThreadId): Promise<ThreadDtoLike & { messages: string[] }> {
  const id = member.client.send('thread.open', { threadId: group })
  const opened = await waitFrame(member.client, 'thread.opened', (f) => f.re === id)
  const messages = (opened.data.messages as { content: string }[]).map((m) => m.content)
  return { ...(opened.data.thread as ThreadDtoLike), messages }
}

/** The thread.updated frames for `group` a member's node got, oldest first. */
function updates(member: Member, group: ThreadId): ThreadDtoLike[] {
  return member.client.frames
    .filter((f) => f.type === 'thread.updated' && frameThread(f) === group)
    .map((f) => f.data.thread as ThreadDtoLike)
}

function ids(thread: ThreadDtoLike | undefined): string[] {
  return (thread?.participants ?? []).map((p) => p.id).sort()
}

async function stored(keith: Keith, group: ThreadId): Promise<string[]> {
  const rows = await keith.repos.messages.range({ threadId: group, afterSeq: 0, limit: 1000 })
  return rows.map((m) => `${m.role}:${m.content}`)
}

describe('group threads on the real core', () => {
  test('start, invite, join, addressing, leave and invite back', async () => {
    const world = await createWorld(cleanups)
    const keith = await startKeith(world, cleanups)
    const tony = await attachOwner(keith, world, cleanups)
    const pepper = await signUp(keith, world, cleanups, 'Pepper')
    const rhodey = await signUp(keith, world, cleanups, 'Rhodey')
    for (const m of [pepper, rhodey]) await greet(keith, m)
    const { chat, utility } = world.fake

    // 1. Tony's model starts the group.
    let group: ThreadId | null = null
    scriptMembership(chat, () => group)
    chat.route(
      {
        name: 'start',
        when: (r) => lastUser(r) === 'Start a group Mission with Pepper and Rhodey.',
        reply: () => [
          fakeToolCall('thread.start_group', {
            participants: ['Pepper', 'rhodey'],
            title: 'Mission',
            purpose: 'Plan the gala.',
          }),
        ],
      },
      { name: 'started', when: (r) => afterTool(r, 'thread.start_group'), reply: () => fakeText('Started.') },
    )
    say(tony, tony.main, 'Start a group Mission with Pepper and Rhodey.')
    const created = await waitFrame(tony.client, 'thread.updated')
    const createdThread = created.data.thread as ThreadDtoLike
    group = createdThread.id as ThreadId
    expect(createdThread).toMatchObject({ kind: 'group', title: 'Mission', purpose: 'Plan the gala.' })
    expect(ids(createdThread)).toEqual([tony.id])
    expect(createdThread.formerParticipants).toEqual([])
    await waitFrame(tony.client, 'message.completed', (f) => frameThread(f) === tony.main)

    // Each invitee gets an invitation delivery (Join / Decline), not the thread: they aren't in it yet.
    for (const m of [pepper, rhodey]) await clickJoin(m)
    await settle(keith)
    const gid = group
    expect(ids(updates(tony, gid).at(-1))).toEqual([tony.id, pepper.id, rhodey.id].sort())
    expect(ids(updates(pepper, gid).at(-1))).toEqual([tony.id, pepper.id, rhodey.id].sort())
    expect(ids(updates(rhodey, gid).at(-1))).toEqual([tony.id, pepper.id, rhodey.id].sort())
    // Pepper's first thread.updated came with her join, not before (pending invitees don't list it).
    expect(ids(updates(pepper, gid)[0])).toContain(pepper.id)
    const invitations = chat.requests.filter((r) => r.system.includes('(invitation from Tony)'))
    expect(invitations[0]?.system).toContain(`"Mission" (${gid}): Plan the gala.`)

    for (const m of [tony, pepper, rhodey]) {
      const opened = await openGroup(m, gid)
      expect(opened.title).toBe('Mission')
    }

    // 2. Addressing. Small talk between humans: no chat request.
    const chatCalls = chat.calls
    say(pepper, gid, 'Rhodey, did you bring the plans?')
    await settle(keith)
    say(rhodey, gid, 'Pepper, they are in the car.')
    await settle(keith)
    expect(chat.calls).toBe(chatCalls)
    expect(utility.calls).toBe(0)
    expect(await stored(keith, gid)).toEqual([
      'user:Rhodey, did you bring the plans?',
      'user:Pepper, they are in the car.',
    ])
    // Tony's node heard both (echo).
    expect(
      tony.client.frames
        .filter((f) => f.type === 'message.user' && frameThread(f) === gid)
        .map((f) => (f.data.message as { content: string }).content),
    ).toEqual(['Rhodey, did you bring the plans?', 'Pepper, they are in the car.'])

    // Naming Keith makes one turn, with names on the user messages.
    let statusReq: LlmRequest | undefined
    chat.route({
      name: 'status',
      when: (r) => lastUser(r) === 'Tony: Keith, status?',
      reply: (r) => {
        statusReq = r
        return fakeText('All on track.')
      },
    })
    say(tony, gid, 'Keith, status?')
    for (const m of [tony, pepper, rhodey]) {
      await waitFrame(
        m.client,
        'message.completed',
        (f) => frameThread(f) === gid && (f.data.message as { content: string }).content === 'All on track.',
      )
    }
    await settle(keith)
    expect(chat.calls).toBe(chatCalls + 1)
    expect(statusReq?.messages.filter((m) => m.role === 'user')).toEqual([
      { role: 'user', name: 'Pepper', content: 'Pepper: Rhodey, did you bring the plans?' },
      { role: 'user', name: 'Rhodey', content: 'Rhodey: Pepper, they are in the car.' },
      { role: 'user', name: 'Tony', content: 'Tony: Keith, status?' },
    ])
    expect(statusReq?.system).toContain('This is the group thread "Mission".')
    expect(statusReq?.system).toContain("You are answering Tony's message.")

    // An unsure line asks fake:utility once; "no" makes no turn.
    utility.push(fakeText(JSON.stringify({ addressed: false, confidence: 0.9 })))
    say(pepper, gid, 'The caterer called again.')
    await settle(keith)
    expect(utility.calls).toBe(1)
    expect(utility.requests[0]?.tools ?? []).toEqual([])
    expect(utility.requests[0]?.messages.at(-1)?.content).toContain('The caterer called again.')
    expect(chat.calls).toBe(chatCalls + 1)
    expect((await stored(keith, gid)).at(-1)).toBe('user:The caterer called again.')

    // 3. Rhodey leaves (from his main thread): his node loses the group, the others see him leave.
    chat.route(
      {
        name: 'leave',
        when: (r) => lastUser(r) === 'Take me out of Mission.',
        reply: () => [fakeToolCall('thread.leave', { threadId: gid })],
      },
      { name: 'left', when: (r) => afterTool(r, 'thread.leave'), reply: () => fakeText('You left Mission.') },
    )
    say(rhodey, rhodey.main, 'Take me out of Mission.')
    const removed = await waitFrame(rhodey.client, 'thread.removed')
    expect(removed.data).toEqual({ threadId: gid })
    await waitFrame(rhodey.client, 'message.completed', (f) => frameThread(f) === rhodey.main)
    await settle(keith)
    for (const m of [tony, pepper]) {
      const last = updates(m, gid).at(-1)
      expect(ids(last)).toEqual([tony.id, pepper.id].sort())
      expect(last?.formerParticipants?.map((p) => p.id)).toEqual([rhodey.id])
    }
    const openId = rhodey.client.send('thread.open', { threadId: gid })
    const refused = await waitFrame(rhodey.client, 'error', (f) => f.re === openId)
    expect(refused.data.code).toBe('FORBIDDEN')
    say(rhodey, gid, 'Still here?')
    const inputRefused = await waitFrame(rhodey.client, 'error', (f) => f.re !== openId)
    expect(inputRefused.data.code).toBe('FORBIDDEN')

    // 4. Tony invites him back (coordinator fix 6a7d292): Rhodey joins again and sees the whole history.
    chat.route(
      {
        name: 'invite back',
        when: (r) => lastUser(r) === 'Tony: Keith, invite Rhodey back.',
        reply: () => [fakeToolCall('thread.invite', { participants: ['Rhodey'] })],
      },
      { name: 'invited', when: (r) => afterTool(r, 'thread.invite'), reply: () => fakeText('Invited.') },
    )
    say(tony, gid, 'Keith, invite Rhodey back.')
    await clickJoin(rhodey)
    await settle(keith)
    const reopened = await openGroup(rhodey, gid)
    expect(ids(reopened)).toEqual([tony.id, pepper.id, rhodey.id].sort())
    expect(reopened.formerParticipants).toEqual([])
    expect(reopened.messages).toEqual(
      expect.arrayContaining([
        'Rhodey, did you bring the plans?',
        'Pepper, they are in the car.',
        'All on track.',
        'The caterer called again.',
        'Invited.',
      ]),
    )

    expect(chat.unmatched.map((r) => r.messages.at(-1)?.content)).toEqual([])
  })
})

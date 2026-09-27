import { describe, expect, test } from 'bun:test'
import { isKeithError } from '@keith/sdk'
import type { NewMemory, PersonId } from '../shared/types.ts'
import { DIGEST_MAX_LINES } from './digest.ts'
import {
  createHousehold,
  HAPPY,
  HAPPY_MAIN,
  MISSION,
  PARTY,
  PEPPER,
  PEPPER_MAIN,
  TONY,
  TONY_MAIN,
} from './testing/fixture.ts'

const v = (...participants: PersonId[]) => ({ participants })

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}

describe('write', () => {
  test('applies defaults and emits memory.written', async () => {
    const h = await createHousehold()
    const m = await h.memory.write({
      content: '  Tony likes espresso.  ',
      subjectPersonId: TONY,
      visibility: 'subject',
      source: 'stated',
    })
    expect(m).toMatchObject({
      content: 'Tony likes espresso.',
      threadId: null,
      authorPersonId: null,
      pinned: false,
      createdAt: 1_000_000,
      updatedAt: 1_000_000,
      lastRecalledAt: null,
    })
    expect(m.id.startsWith('mem_')).toBe(true)
    expect(await h.memories.get(m.id)).toEqual(m)
    await h.events.idle()
    expect(h.events.emitted).toContainEqual({
      name: 'memory.written',
      data: { memoryId: m.id, visibility: 'subject', subjectPersonId: TONY },
    })
  })

  test.each<[string, NewMemory]>([
    ['empty content', { content: ' ', subjectPersonId: TONY, visibility: 'subject', source: 'stated' }],
    [
      'subject without subject',
      { content: 'x', subjectPersonId: null, visibility: 'subject', source: 'stated' },
    ],
    [
      'thread without thread',
      { content: 'x', subjectPersonId: null, visibility: 'thread', source: 'stated' },
    ],
  ])('rejects %s', async (_name, m) => {
    const h = await createHousehold()
    expect(isKeithError(await rejection(h.memory.write(m)), 'INTERNAL')).toBe(true)
    expect(h.memories.rows.size).toBe(0)
  })
})

describe('recall', () => {
  test('returns visible matches and marks them recalled', async () => {
    const h = await createHousehold()
    const m = await h.memory.write({
      content: 'The Expo venue is by the river.',
      subjectPersonId: null,
      visibility: 'household',
      source: 'stated',
    })
    h.clock.advance(500)
    const found = await h.memory.recall({ text: 'venue river', viewer: v(PEPPER) })
    expect(found.map((x) => x.id)).toEqual([m.id])
    expect((await h.memories.get(m.id))?.lastRecalledAt).toBe(1_000_500)
  })

  test('I-4: never returns an invisible memory even if storage returns it', async () => {
    const h = await createHousehold()
    h.memories.ignoreFilter = true
    await h.memory.write({
      content: 'Pepper likes tulips.',
      subjectPersonId: PEPPER,
      visibility: 'subject',
      source: 'stated',
    })
    await h.memory.write({
      content: 'Tulips for the owner.',
      subjectPersonId: null,
      visibility: 'owner',
      source: 'stated',
    })
    await h.memory.write({
      content: 'Tulips in the mission.',
      subjectPersonId: null,
      visibility: 'thread',
      threadId: MISSION,
      source: 'stated',
    })
    const visible = await h.memory.write({
      content: 'Tulips at home.',
      subjectPersonId: null,
      visibility: 'household',
      source: 'stated',
    })

    const forTony = await h.memory.recall({ text: 'tulips', viewer: v(TONY) })
    expect(forTony.map((m) => m.content).sort()).toEqual([
      'Tulips at home.',
      'Tulips for the owner.',
      'Tulips in the mission.',
    ])
    const forHappy = await h.memory.recall({ text: 'tulips', viewer: v(HAPPY) })
    expect(forHappy).toEqual([])
    const forParty = await h.memory.recall({ text: 'tulips', viewer: v(TONY, PEPPER, HAPPY) })
    expect(forParty).toEqual([])
    const forPepper = await h.memory.recall({ text: 'tulips', viewer: v(PEPPER) })
    expect(forPepper.map((m) => m.id).sort()).toContain(visible.id)
    expect(forPepper.some((m) => m.visibility === 'owner')).toBe(false)
    expect(h.log.entries.some((e) => e.msg === 'storage returned invisible memories')).toBe(true)
  })

  test('empty query returns nothing', async () => {
    const h = await createHousehold()
    expect(await h.memory.recall({ text: '  ', viewer: v(TONY) })).toEqual([])
  })

  test('respects the limit', async () => {
    const h = await createHousehold()
    for (let i = 0; i < 12; i++) {
      await h.memory.write({
        content: `Suit mark ${i}`,
        subjectPersonId: null,
        visibility: 'household',
        source: 'stated',
      })
    }
    expect(await h.memory.recall({ text: 'suit', viewer: v(TONY) })).toHaveLength(8)
    expect(await h.memory.recall({ text: 'suit', viewer: v(TONY), limit: 3 })).toHaveLength(3)
  })
})

describe('core', () => {
  test('I-4: pinned and visible only', async () => {
    const h = await createHousehold()
    const pin = (content: string, extra: Partial<NewMemory>) =>
      h.memory.write({
        content,
        subjectPersonId: null,
        visibility: 'household',
        source: 'stated',
        pinned: true,
        ...extra,
      })
    await pin('Household pinned.', {})
    await pin('Tony pinned.', { visibility: 'subject', subjectPersonId: TONY })
    await pin('Owner pinned.', { visibility: 'owner' })
    await h.memory.write({
      content: 'Not pinned.',
      subjectPersonId: null,
      visibility: 'household',
      source: 'stated',
    })

    const pepper = await h.memory.core(v(PEPPER))
    expect(pepper.map((m) => m.content)).toEqual(['Household pinned.'])
    const tony = await h.memory.core(v(TONY))
    expect(tony.map((m) => m.content).sort()).toEqual(['Household pinned.', 'Owner pinned.', 'Tony pinned.'])
    expect(await h.memory.core(v(HAPPY))).toEqual([])
    expect((await h.memory.core(v(TONY, PEPPER))).map((m) => m.content)).toEqual(['Household pinned.'])
  })

  test('capped by memory.coreMaxChars, newest first', async () => {
    const h = await createHousehold({ coreMaxChars: 25 })
    const write = async (content: string) => {
      await h.memory.write({
        content,
        subjectPersonId: null,
        visibility: 'household',
        source: 'stated',
        pinned: true,
      })
      h.clock.advance(1)
    }
    await write('aaaaaaaaaa') // 10, oldest
    await write('bbbbbbbbbbbbbbbbbbbb') // 20, does not fit after c
    await write('cccccccccc') // 10, newest
    const core = await h.memory.core(v(TONY))
    expect(core.map((m) => m.content)).toEqual(['cccccccccc', 'aaaaaaaaaa'])
    expect(core.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(25)
  })
})

describe('index', () => {
  test('lists subjects and topics that exist but are not in core', async () => {
    const h = await createHousehold()
    await h.memory.write({
      content: 'Pepper prefers venues near the river.',
      subjectPersonId: PEPPER,
      visibility: 'household',
      source: 'stated',
    })
    await h.memory.write({
      content: 'The venue budget is modest.',
      subjectPersonId: null,
      visibility: 'household',
      source: 'stated',
    })
    await h.memory.write({
      content: 'Pinned espresso fact.',
      subjectPersonId: null,
      visibility: 'household',
      source: 'stated',
      pinned: true,
    })
    await h.memory.write({
      content: 'Secret armor schematics.',
      subjectPersonId: TONY,
      visibility: 'subject',
      source: 'stated',
    })

    const index = await h.memory.index(v(PEPPER))
    expect(index[0]).toBe('Pepper')
    expect(index).toContain('venue')
    expect(index).toContain('river')
    expect(index).not.toContain('espresso') // in core
    expect(index).not.toContain('Tony') // I-4: invisible subject
    expect(index).not.toContain('armor')
    expect(index).not.toContain('the')
  })

  test('I-4: guests see no household subjects', async () => {
    const h = await createHousehold()
    await h.memory.write({
      content: 'Pepper prefers venues near the river.',
      subjectPersonId: PEPPER,
      visibility: 'household',
      source: 'stated',
    })
    expect(await h.memory.index(v(HAPPY))).toEqual([])
  })
})

describe('digest', () => {
  test("I-4: person B's digest never contains the goal of person A's subject task", async () => {
    const h = await createHousehold()
    await h.addTask({
      n: 1,
      personId: TONY,
      threadId: TONY_MAIN,
      goal: 'Research the Stark Expo venue options',
    })

    const pepper = await h.memory.digest({ threadId: PEPPER_MAIN, viewer: v(PEPPER) })
    expect(pepper).not.toContain('Stark Expo')
    expect(pepper).not.toContain('Tony')
    expect(pepper).toBe('- Busy with 1 private background task for someone else.')

    const tony = await h.memory.digest({ threadId: TONY_MAIN, viewer: v(TONY) })
    expect(tony).toBe('- Working on a background task for you: Research the Stark Expo venue options')
  })

  test('I-4: a group viewer gets only generic lines for a member-private task', async () => {
    const h = await createHousehold()
    await h.addTask({ n: 1, personId: TONY, threadId: TONY_MAIN, goal: 'Secret suit upgrade' })
    await h.addTask({ n: 2, personId: TONY, threadId: MISSION, goal: 'Map the route', visibility: 'thread' })
    const d = await h.memory.digest({ threadId: MISSION, viewer: v(TONY, PEPPER) })
    expect(d).not.toContain('Secret suit')
    expect(d).toContain('- Working on a background task for Tony: Map the route')
    expect(d).toContain('- Busy with 1 private background task for someone else.')
  })

  test('guests get counts only, never names or goals', async () => {
    const h = await createHousehold()
    await h.addTask({ n: 1, personId: HAPPY, threadId: HAPPY_MAIN, goal: 'Find a parking spot' })
    await h.addTask({ n: 2, personId: TONY, threadId: TONY_MAIN, goal: 'Research venues' })
    h.events.emit('thread.state_changed', { threadId: TONY_MAIN, from: 'idle', to: 'thinking' })
    await h.events.idle()
    const d = await h.memory.digest({ threadId: HAPPY_MAIN, viewer: v(HAPPY) })
    expect(d).toBe('- Also busy with 1 other conversation and 2 background tasks.')
    const party = await h.memory.digest({ threadId: PARTY, viewer: v(TONY, PEPPER, HAPPY) })
    expect(party).not.toContain('Research')
    expect(party).not.toContain('Tony')
  })

  test('busy threads come from thread.state_changed; the current thread is left out', async () => {
    const h = await createHousehold()
    h.events.emit('thread.state_changed', { threadId: TONY_MAIN, from: 'idle', to: 'thinking' })
    h.events.emit('thread.state_changed', { threadId: MISSION, from: 'idle', to: 'speaking' })
    h.events.emit('thread.state_changed', { threadId: PEPPER_MAIN, from: 'idle', to: 'thinking' })
    await h.events.idle()

    const tony = await h.memory.digest({ threadId: TONY_MAIN, viewer: v(TONY) })
    expect(tony).toBe(
      ['- Replying in your other thread "Mission".', '- In 1 conversation with someone else.'].join('\n'),
    )

    h.events.emit('thread.state_changed', { threadId: MISSION, from: 'speaking', to: 'idle' })
    h.events.emit('thread.state_changed', { threadId: PEPPER_MAIN, from: 'thinking', to: 'idle' })
    await h.events.idle()
    expect(await h.memory.digest({ threadId: TONY_MAIN, viewer: v(TONY) })).toBe('')
  })

  test('tasks reported ended by task.* events are left out even if storage still lists them', async () => {
    const h = await createHousehold()
    const id = await h.addTask({ n: 1, personId: TONY, threadId: TONY_MAIN, goal: 'Research venues' })
    h.events.emit('task.completed', { taskId: id, personId: TONY, summary: 'done' })
    await h.events.idle()
    expect(await h.memory.digest({ threadId: TONY_MAIN, viewer: v(TONY) })).toBe('')
  })

  test(`at most ${DIGEST_MAX_LINES} lines`, async () => {
    const h = await createHousehold()
    for (let i = 1; i <= 8; i++) {
      await h.addTask({ n: i, personId: TONY, threadId: TONY_MAIN, goal: `Goal ${i}` })
    }
    await h.addTask({ n: 9, personId: PEPPER, threadId: PEPPER_MAIN, goal: 'Pepper goal' })
    const lines = (await h.memory.digest({ threadId: TONY_MAIN, viewer: v(TONY) })).split('\n')
    expect(lines).toHaveLength(DIGEST_MAX_LINES)
    expect(lines[3]).toBe('- And 5 more things going on.')
    expect(lines[4]).toBe('- Busy with 1 private background task for someone else.')
  })

  test('stop() unsubscribes from the bus', async () => {
    const h = await createHousehold()
    h.memory.stop()
    h.events.emit('thread.state_changed', { threadId: MISSION, from: 'idle', to: 'thinking' })
    await h.events.idle()
    expect(await h.memory.digest({ threadId: TONY_MAIN, viewer: v(TONY) })).toBe('')
  })
})

describe('forget', () => {
  test('owner or subject only, and only visible memories', async () => {
    const h = await createHousehold()
    const aboutTony = await h.memory.write({
      content: 'Tony hates tomatoes.',
      subjectPersonId: TONY,
      visibility: 'household',
      source: 'stated',
    })
    const pepperOnly = await h.memory.write({
      content: 'Pepper secret.',
      subjectPersonId: PEPPER,
      visibility: 'subject',
      source: 'stated',
    })

    expect(await h.memory.forget({ id: aboutTony.id, person: h.dto.pepper, viewer: v(PEPPER) })).toBe(
      'forbidden',
    )
    expect(await h.memory.forget({ id: pepperOnly.id, person: h.dto.tony, viewer: v(TONY) })).toBe(
      'not_found',
    )
    expect(await h.memory.forget({ id: pepperOnly.id, person: h.dto.pepper, viewer: v(PEPPER) })).toBe(
      'forgotten',
    )
    expect(await h.memory.forget({ id: aboutTony.id, person: h.dto.tony, viewer: v(TONY) })).toBe('forgotten')
    expect(h.memories.rows.size).toBe(0)
  })
})

import { describe, expect, test } from 'bun:test'
import { HAPPY, MISSION, PEPPER, TONY, TONY_MAIN } from '../testing/fixture.ts'
import { createReflectionHarness, jsonTurn, promptText } from '../testing/reflect.ts'
import { capNotes, parseJsonReply } from './reflector.ts'

const signal = () => new AbortController().signal

function extract(facts: { content: string; about: string | null }[], notes: unknown[] = []) {
  return jsonTurn({ facts, notes })
}

describe('reflector: what it writes (ADR-0014)', () => {
  test('a stated fact about the participant becomes a subject memory, inferred, no author, not pinned', async () => {
    const h = await createReflectionHarness({
      script: [extract([{ content: "Tony's sister is called Maria.", about: TONY }])],
    })
    await h.say(TONY_MAIN, TONY, 'My sister Maria is visiting next week.')
    await h.say(TONY_MAIN, null, 'Nice, say hi to Maria.')

    const result = await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })

    const [m] = [...h.memories.rows.values()]
    expect(m).toMatchObject({
      content: "Tony's sister is called Maria.",
      visibility: 'subject',
      subjectPersonId: TONY,
      threadId: TONY_MAIN,
      source: 'inferred',
      authorPersonId: null,
      pinned: false,
    })
    expect(result?.written).toEqual([m?.id as NonNullable<typeof m>['id']])
    expect(h.events.emitted.some((e) => e.name === 'memory.written')).toBe(true)
  })

  test('calls the utility model once, with no tools, one step, no persistence, on behalf of the thread', async () => {
    const h = await createReflectionHarness({ script: [extract([])] })
    await h.say(TONY_MAIN, TONY, 'Hello there.')
    await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect(h.runLoop.calls).toHaveLength(1)
    expect(h.runLoop.calls[0]).toMatchObject({
      modelRole: 'utility',
      tools: [],
      maxSteps: 1,
      persist: null,
      runCtx: { personId: TONY, participants: [TONY], threadId: TONY_MAIN, taskId: null },
    })
  })

  test('a fact about someone else, or about nobody, becomes a thread memory', async () => {
    const h = await createReflectionHarness({
      script: [
        extract([
          { content: 'Pepper is flying to Tokyo on Monday.', about: PEPPER },
          { content: 'The plumber comes on Thursday.', about: null },
        ]),
      ],
    })
    await h.say(TONY_MAIN, TONY, 'Pepper flies to Tokyo on Monday, and the plumber comes Thursday.')
    await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    const rows = [...h.memories.rows.values()]
    expect(rows).toHaveLength(2)
    for (const m of rows) {
      expect(m).toMatchObject({ visibility: 'thread', threadId: TONY_MAIN, subjectPersonId: null })
    }
  })

  test('household is never produced, even when the model asks for it', async () => {
    const h = await createReflectionHarness({
      script: [
        jsonTurn({
          facts: [{ content: 'The house wifi is called Jarvis.', about: null, visibility: 'household' }],
          notes: [],
        }),
        jsonTurn({
          facts: [{ content: "Tony's car is a red Audi.", about: TONY, visibility: 'household' }],
          notes: [],
        }),
      ],
    })
    await h.say(TONY_MAIN, TONY, 'The wifi is called Jarvis.')
    await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    await h.say(MISSION, TONY, 'My car is a red Audi.')
    await h.reflection.reflector.reflect({ threadId: MISSION, signal: signal() })

    const rows = [...h.memories.rows.values()]
    expect(rows).toHaveLength(2)
    expect(rows.map((m) => m.visibility)).toEqual(['thread', 'thread'])
    // Group thread: always thread, and the subject is kept when it is a participant.
    expect(rows[1]).toMatchObject({ threadId: MISSION, subjectPersonId: TONY })
  })

  test('an about that is not a participant is treated as null', async () => {
    const h = await createReflectionHarness({
      script: [extract([{ content: 'Happy likes boxing.', about: HAPPY }])],
    })
    await h.say(MISSION, TONY, 'Happy likes boxing.')
    await h.reflection.reflector.reflect({ threadId: MISSION, signal: signal() })
    expect([...h.memories.rows.values()][0]).toMatchObject({
      visibility: 'thread',
      threadId: MISSION,
      subjectPersonId: null,
    })
  })

  test('tool-step assistant rows are skipped; a cancelled reply counts up to its stored content', async () => {
    const h = await createReflectionHarness({ script: [extract([])] })
    await h.say(TONY_MAIN, TONY, 'What is the weather?')
    await h.say(TONY_MAIN, null, 'SECRET-TOOL-STEP', { toolCalls: true })
    await h.say(TONY_MAIN, null, 'It is sunny and', { meta: { cancelled: true } })
    await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    const prompt = promptText(h.llm.requests[0] as NonNullable<(typeof h.llm.requests)[0]>)
    expect(prompt).not.toContain('SECRET-TOOL-STEP')
    expect(prompt).toContain('It is sunny and')
    expect(prompt).toContain('What is the weather?')
  })
})

describe('reflector: dedupe and merge', () => {
  test('a duplicate is dropped', async () => {
    const h = await createReflectionHarness({
      script: [
        extract([{ content: "Tony's sister is called Maria.", about: TONY }]),
        jsonTurn({ decisions: [{ candidate: 1, action: 'duplicate' }] }),
      ],
    })
    await h.seedMemory(1, {
      content: "Tony's sister is called Maria.",
      visibility: 'subject',
      subjectPersonId: TONY,
      threadId: TONY_MAIN,
    })
    await h.say(TONY_MAIN, TONY, 'My sister Maria called.')
    const result = await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect(h.memories.rows.size).toBe(1)
    expect(h.llm.calls).toBe(2)
    expect(result).toMatchObject({ written: [], merged: [] })
  })

  test('an inferred match is updated (content and updatedAt only)', async () => {
    const h = await createReflectionHarness()
    const old = await h.seedMemory(1, {
      content: "Tony's sister is called Mary.",
      visibility: 'subject',
      subjectPersonId: TONY,
      threadId: TONY_MAIN,
      pinned: true,
    })
    h.llm.push(
      extract([{ content: "Tony's sister is called Maria, not Mary.", about: TONY }]),
      jsonTurn({
        decisions: [
          { candidate: 1, action: 'update', id: old.id, content: "Tony's sister is called Maria." },
        ],
      }),
    )
    await h.say(TONY_MAIN, TONY, "Actually my sister's name is Maria, not Mary.")
    const result = await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect(h.memories.rows.size).toBe(1)
    expect(await h.memories.get(old.id)).toEqual({
      ...old,
      content: "Tony's sister is called Maria.",
      updatedAt: h.clock.now(),
    })
    expect(result).toMatchObject({ written: [], merged: [old.id] })
    // The merge prompt holds the candidate and its match.
    const mergePrompt = promptText(h.llm.requests[1] as NonNullable<(typeof h.llm.requests)[1]>)
    expect(mergePrompt).toContain(old.id)
  })

  test('a stated match by someone else is not rewritten: a new memory instead', async () => {
    const h = await createReflectionHarness()
    const stated = await h.seedMemory(1, {
      content: "Tony's sister is called Mary.",
      visibility: 'subject',
      subjectPersonId: TONY,
      threadId: TONY_MAIN,
      source: 'stated',
      authorPersonId: PEPPER,
    })
    h.llm.push(
      extract([{ content: "Tony's sister is called Maria.", about: TONY }]),
      jsonTurn({ decisions: [{ candidate: 1, action: 'update', id: stated.id, content: 'rewritten' }] }),
    )
    await h.say(TONY_MAIN, TONY, 'My sister is Maria.')
    const result = await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect((await h.memories.get(stated.id))?.content).toBe("Tony's sister is called Mary.")
    expect(h.memories.rows.size).toBe(2)
    expect(result?.written).toHaveLength(1)
    expect(result?.merged).toEqual([])
  })

  test('a stated match is rewritten when its author spoke in this pass (a self-correction)', async () => {
    const h = await createReflectionHarness()
    const stated = await h.seedMemory(1, {
      content: "Tony's sister is called Mary.",
      visibility: 'subject',
      subjectPersonId: TONY,
      threadId: TONY_MAIN,
      source: 'stated',
      authorPersonId: TONY,
    })
    h.llm.push(
      extract([{ content: "Tony's sister is called Maria.", about: TONY }]),
      jsonTurn({
        decisions: [
          { candidate: 1, action: 'update', id: stated.id, content: "Tony's sister is called Maria." },
        ],
      }),
    )
    await h.say(TONY_MAIN, TONY, 'Correction: my sister is Maria.')
    await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect(await h.memories.get(stated.id)).toMatchObject({
      content: "Tony's sister is called Maria.",
      source: 'stated',
      authorPersonId: TONY,
    })
  })

  test('plugin and relayed memories are never rewritten', async () => {
    const h = await createReflectionHarness()
    const plugin = await h.seedMemory(1, {
      content: 'The plumber visit is on Thursday.',
      visibility: 'thread',
      threadId: TONY_MAIN,
      source: 'plugin',
    })
    const relayed = await h.seedMemory(2, {
      content: 'The plumber was sent by Pepper.',
      visibility: 'thread',
      threadId: TONY_MAIN,
      source: 'relayed',
    })
    h.llm.push(
      extract([
        { content: 'The plumber visit moved to Friday.', about: null },
        { content: 'The plumber was sent by Happy.', about: null },
      ]),
      jsonTurn({
        decisions: [
          { candidate: 1, action: 'update', id: plugin.id, content: 'x' },
          { candidate: 2, action: 'update', id: relayed.id, content: 'y' },
        ],
      }),
    )
    await h.say(TONY_MAIN, TONY, 'The plumber moved to Friday, and Happy sent him.')
    const result = await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect(await h.memories.get(plugin.id)).toEqual(plugin)
    expect(await h.memories.get(relayed.id)).toEqual(relayed)
    expect(result?.written).toHaveLength(2)
    expect(result?.merged).toEqual([])
  })

  test('an update naming a memory outside the candidate matches becomes new', async () => {
    const h = await createReflectionHarness()
    const other = await h.seedMemory(1, {
      content: "Pepper's sister is called Natalie.",
      visibility: 'subject',
      subjectPersonId: PEPPER,
      threadId: null,
    })
    await h.seedMemory(2, {
      content: "Tony's sister is called Mary.",
      visibility: 'subject',
      subjectPersonId: TONY,
      threadId: TONY_MAIN,
    })
    h.llm.push(
      extract([{ content: "Tony's sister is called Maria.", about: TONY }]),
      jsonTurn({ decisions: [{ candidate: 1, action: 'update', id: other.id, content: 'hijacked' }] }),
    )
    await h.say(TONY_MAIN, TONY, 'My sister is Maria.')
    await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect(await h.memories.get(other.id)).toEqual(other)
    expect(h.memories.rows.size).toBe(3)
  })

  test('only memories in the same scope are matched', async () => {
    const h = await createReflectionHarness({
      script: [extract([{ content: "Tony's sister is called Maria.", about: TONY }])],
    })
    // Same words, other scopes: a thread memory of this thread, and household.
    await h.seedMemory(1, {
      content: "Tony's sister is called Maria.",
      visibility: 'thread',
      threadId: TONY_MAIN,
    })
    await h.seedMemory(2, { content: "Tony's sister is called Maria.", visibility: 'household' })
    await h.say(TONY_MAIN, TONY, 'My sister is Maria.')
    await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    // No match in scope, so no merge call, and the fact is written as a subject memory.
    expect(h.llm.calls).toBe(1)
    expect(h.memories.rows.size).toBe(3)
  })
})

describe('reflector: relationship cards', () => {
  test('notes are capped, tone and blockedRelayFrom are kept', async () => {
    const h = await createReflectionHarness({ reflect: { cardMaxChars: 60 } })
    await h.relationships.upsert({
      personId: TONY,
      tone: 'playful, teasing',
      notes: 'Likes short answers.',
      blockedRelayFrom: [HAPPY],
    })
    h.llm.push(
      extract([], [{ personId: TONY, notes: `Likes short answers. ${'Prefers metric units. '.repeat(20)}` }]),
    )
    await h.say(TONY_MAIN, TONY, 'Use metric units, please.')
    const result = await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    const card = await h.relationships.get(TONY)
    expect(card?.tone).toBe('playful, teasing')
    expect(card?.blockedRelayFrom).toEqual([HAPPY])
    expect(card?.notes.length).toBeLessThanOrEqual(60)
    expect(card?.notes.startsWith('Likes short answers. Prefers metric units.')).toBe(true)
    expect(result?.cardsUpdated).toEqual([TONY])
    // The current notes were in the prompt, so the model rewrites from them.
    expect(promptText(h.llm.requests[0] as NonNullable<(typeof h.llm.requests)[0]>)).toContain(
      'Likes short answers.',
    )
  })

  test('a card is created with an empty tone when none exists; unchanged notes are not rewritten', async () => {
    const h = await createReflectionHarness({
      script: [
        extract([], [{ personId: 'Tony', notes: 'Prefers English.' }]),
        extract([], [{ personId: TONY, notes: 'Prefers English.' }]),
      ],
    })
    await h.say(TONY_MAIN, TONY, 'Please answer in English.')
    await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect(await h.relationships.get(TONY)).toEqual({
      personId: TONY,
      tone: '',
      notes: 'Prefers English.',
      blockedRelayFrom: [],
    })
    await h.say(TONY_MAIN, TONY, 'Thanks.')
    const second = await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect(second?.cardsUpdated).toEqual([])
  })

  test('a group pass writes only thread memories, keeps about as the subject, and updates no card', async () => {
    const h = await createReflectionHarness({
      script: [
        extract(
          [
            { content: 'Tony is afraid of flying.', about: TONY },
            { content: 'Pepper books the Expo venue.', about: 'Pepper' },
            { content: 'The Expo opens on May 3.', about: null },
          ],
          [
            { personId: TONY, notes: 'Likes jokes.' },
            { personId: PEPPER, notes: 'Wants lists.' },
          ],
        ),
      ],
    })
    await h.say(MISSION, TONY, 'I hate flying. Pepper, can you book the venue? We open May 3.')
    await h.say(MISSION, PEPPER, 'Sure, I will book it.')
    const result = await h.reflection.reflector.reflect({ threadId: MISSION, signal: signal() })

    const rows = [...h.memories.rows.values()]
    expect(rows.map((m) => [m.visibility, m.threadId, m.subjectPersonId])).toEqual([
      ['thread', MISSION, TONY],
      ['thread', MISSION, PEPPER],
      ['thread', MISSION, null],
    ])
    expect(result?.cardsUpdated).toEqual([])
    expect(h.relationships.rows.size).toBe(0)
  })

  test('group threads never update cards', async () => {
    const h = await createReflectionHarness({
      script: [extract([], [{ personId: TONY, notes: 'Likes jokes.' }])],
    })
    await h.say(MISSION, TONY, 'Tell me a joke.')
    const result = await h.reflection.reflector.reflect({ threadId: MISSION, signal: signal() })
    expect(h.relationships.rows.size).toBe(0)
    expect(result?.cardsUpdated).toEqual([])
  })
})

describe('reflector: cursor and event', () => {
  test('the cursor advances after success and memory.reflected carries the counts', async () => {
    const h = await createReflectionHarness()
    const old = await h.seedMemory(1, {
      content: "Tony's sister is called Mary.",
      visibility: 'subject',
      subjectPersonId: TONY,
      threadId: TONY_MAIN,
    })
    h.llm.push(
      extract(
        [
          { content: "Tony's sister is called Maria.", about: TONY },
          { content: 'Tony drives a red Audi.', about: TONY },
        ],
        [{ personId: TONY, notes: 'Likes short answers.' }],
      ),
      jsonTurn({
        decisions: [
          { candidate: 1, action: 'update', id: old.id, content: "Tony's sister is called Maria." },
        ],
      }),
    )
    await h.say(TONY_MAIN, TONY, 'My sister is Maria. I drive a red Audi. Keep it short.')
    const last = await h.say(TONY_MAIN, null, 'Noted.')
    const result = await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })

    expect(result?.throughSeq).toBe(last)
    expect((await h.threads.get(TONY_MAIN))?.reflectedThroughSeq).toBe(last)
    expect(h.events.emitted.filter((e) => e.name === 'memory.reflected')).toEqual([
      {
        name: 'memory.reflected',
        data: { threadId: TONY_MAIN, throughSeq: last, written: 1, merged: 1, cardsUpdated: 1 },
      },
    ])
  })

  test('the next pass reads only messages after the cursor, and nothing new returns null', async () => {
    const h = await createReflectionHarness({ script: [extract([]), extract([])] })
    await h.say(TONY_MAIN, TONY, 'FIRST-MESSAGE')
    await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect(await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })).toBeNull()
    expect(h.llm.calls).toBe(1)
    await h.say(TONY_MAIN, TONY, 'SECOND-MESSAGE')
    await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    const prompt = promptText(h.llm.requests[1] as NonNullable<(typeof h.llm.requests)[1]>)
    expect(prompt).toContain('SECOND-MESSAGE')
    expect(prompt).not.toContain('FIRST-MESSAGE')
  })

  test('reads at most maxMessages; the rest wait for the next pass', async () => {
    const h = await createReflectionHarness({ reflect: { maxMessages: 2 }, script: [extract([])] })
    await h.say(TONY_MAIN, TONY, 'one')
    const second = await h.say(TONY_MAIN, TONY, 'two')
    await h.say(TONY_MAIN, TONY, 'three')
    const result = await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect(result?.throughSeq).toBe(second)
  })

  test('a pass with only tool steps moves the cursor without calling the model', async () => {
    const h = await createReflectionHarness()
    const last = await h.say(TONY_MAIN, null, 'tool step', { toolCalls: true })
    const result = await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect(h.llm.calls).toBe(0)
    expect(result).toEqual({
      threadId: TONY_MAIN,
      throughSeq: last,
      written: [],
      merged: [],
      cardsUpdated: [],
    })
  })
})

describe('reflector helpers', () => {
  test('parseJsonReply tolerates a code fence and surrounding text', () => {
    expect(parseJsonReply('```json\n{"facts":[]}\n```')).toEqual({ facts: [] })
    expect(parseJsonReply('Sure! {"a":1} done')).toEqual({ a: 1 })
    expect(parseJsonReply('no json')).toBeUndefined()
    expect(parseJsonReply('{broken')).toBeUndefined()
  })

  test('capNotes keeps short notes and cuts long ones at a word boundary', () => {
    expect(capNotes('  short  ', 10)).toBe('short')
    expect(capNotes('alpha beta gamma delta', 12)).toBe('alpha beta')
    expect(capNotes('x'.repeat(30), 10)).toBe('x'.repeat(10))
  })
})

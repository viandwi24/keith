import { describe, expect, test } from 'bun:test'
import { ProviderError } from '@keith/sdk'
import { TONY, TONY_MAIN } from '../testing/fixture.ts'
import { createReflectionHarness, jsonTurn, promptText } from '../testing/reflect.ts'
import { RETRY_NOTE } from './prompts.ts'
import { MAX_FAILED_PASSES } from './reflector.ts'

const signal = () => new AbortController().signal
const garbage = [{ type: 'text.delta' as const, text: 'Sure, here are the facts: Tony has a sister.' }]
const reflectedEvents = (h: { events: { emitted: { name: string; data: unknown }[] } }) =>
  h.events.emitted.filter((e) => e.name === 'memory.reflected')

describe('reflector failures', () => {
  test('invalid JSON is retried once in the same pass', async () => {
    const h = await createReflectionHarness({
      script: [garbage, jsonTurn({ facts: [{ content: 'Tony has a sister.', about: TONY }], notes: [] })],
    })
    await h.say(TONY_MAIN, TONY, 'I have a sister.')
    const result = await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect(h.llm.calls).toBe(2)
    expect(promptText(h.llm.requests[1] as NonNullable<(typeof h.llm.requests)[1]>)).toContain(RETRY_NOTE)
    expect(result?.written).toHaveLength(1)
  })

  test('a reply of the wrong shape counts as invalid too', async () => {
    const h = await createReflectionHarness({
      script: [jsonTurn({ facts: 'none' }), jsonTurn({ facts: [] })],
    })
    await h.say(TONY_MAIN, TONY, 'Hi.')
    expect(await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })).not.toBeNull()
    expect(h.llm.calls).toBe(2)
  })

  test('invalid twice: warning logged, cursor stays, nothing written', async () => {
    const h = await createReflectionHarness({ script: [garbage, garbage] })
    await h.say(TONY_MAIN, TONY, 'I have a sister.')
    expect(await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })).toBeNull()
    expect(h.llm.calls).toBe(2)
    expect((await h.threads.get(TONY_MAIN))?.reflectedThroughSeq ?? null).toBeNull()
    expect(h.memories.rows.size).toBe(0)
    expect(reflectedEvents(h)).toEqual([])
    expect(h.log.entries.some((e) => e.level === 'warn' && e.msg.includes('invalid'))).toBe(true)
  })

  test('an invalid merge reply fails the pass without writing the extracted facts', async () => {
    const h = await createReflectionHarness({
      script: [
        jsonTurn({ facts: [{ content: "Tony's sister is Maria.", about: TONY }], notes: [] }),
        garbage,
        garbage,
      ],
    })
    await h.seedMemory(1, {
      content: "Tony's sister is Mary.",
      visibility: 'subject',
      subjectPersonId: TONY,
      threadId: TONY_MAIN,
    })
    await h.say(TONY_MAIN, TONY, 'My sister is Maria.')
    expect(await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })).toBeNull()
    expect(h.memories.rows.size).toBe(1)
  })

  test(`${MAX_FAILED_PASSES} failed passes over the same range advance the cursor with zero counts`, async () => {
    const h = await createReflectionHarness({ script: [], reflect: {} })
    h.llm.push(...Array.from({ length: MAX_FAILED_PASSES * 2 }, () => garbage))
    await h.say(TONY_MAIN, TONY, 'poison')
    const last = await h.say(TONY_MAIN, null, 'reply')

    for (let i = 1; i < MAX_FAILED_PASSES; i++) {
      expect(await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })).toBeNull()
    }
    expect((await h.threads.get(TONY_MAIN))?.reflectedThroughSeq ?? null).toBeNull()

    const result = await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect(result).toEqual({
      threadId: TONY_MAIN,
      throughSeq: last,
      written: [],
      merged: [],
      cardsUpdated: [],
    })
    expect((await h.threads.get(TONY_MAIN))?.reflectedThroughSeq).toBe(last)
    expect(reflectedEvents(h)).toEqual([
      {
        name: 'memory.reflected',
        data: { threadId: TONY_MAIN, throughSeq: last, written: 0, merged: 0, cardsUpdated: 0 },
      },
    ])
    expect(h.log.entries.some((e) => e.level === 'error')).toBe(true)
  })

  test('a success in between resets the failure count', async () => {
    const h = await createReflectionHarness()
    h.llm.push(garbage, garbage, jsonTurn({ facts: [], notes: [] }))
    await h.say(TONY_MAIN, TONY, 'first')
    await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    h.llm.push(...Array.from({ length: 4 }, () => garbage))
    await h.say(TONY_MAIN, TONY, 'second')
    expect(await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })).toBeNull()
    expect(await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })).toBeNull()
  })

  test('a provider error is logged, the cursor stays, and it never counts as a poison batch', async () => {
    const h = await createReflectionHarness()
    const fail = () => {
      throw new ProviderError('auth', 'bad key')
    }
    h.llm.push(...Array.from({ length: MAX_FAILED_PASSES + 1 }, () => fail))
    await h.say(TONY_MAIN, TONY, 'hello')
    for (let i = 0; i <= MAX_FAILED_PASSES; i++) {
      expect(await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })).toBeNull()
    }
    expect((await h.threads.get(TONY_MAIN))?.reflectedThroughSeq ?? null).toBeNull()
    expect(reflectedEvents(h)).toEqual([])
    expect(h.log.entries.some((e) => e.level === 'warn' && e.msg.includes('cursor kept'))).toBe(true)
  })

  test('an abort during the merge call writes nothing', async () => {
    const controller = new AbortController()
    const h = await createReflectionHarness({
      script: [
        jsonTurn({
          facts: [
            { content: "Tony's sister is Maria.", about: TONY },
            { content: 'Tony drives an Audi.', about: TONY },
          ],
          notes: [{ personId: TONY, notes: 'Short answers.' }],
        }),
        () => {
          controller.abort()
          return jsonTurn({ decisions: [] })
        },
      ],
    })
    await h.seedMemory(1, {
      content: "Tony's sister is Mary.",
      visibility: 'subject',
      subjectPersonId: TONY,
      threadId: TONY_MAIN,
    })
    await h.say(TONY_MAIN, TONY, 'My sister is Maria and I drive an Audi.')
    expect(
      await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: controller.signal }),
    ).toBeNull()
    expect(h.memories.rows.size).toBe(1)
    expect(h.relationships.rows.size).toBe(0)
    expect((await h.threads.get(TONY_MAIN))?.reflectedThroughSeq ?? null).toBeNull()
    expect(reflectedEvents(h)).toEqual([])
  })

  test('an already aborted signal calls no model', async () => {
    const h = await createReflectionHarness()
    await h.say(TONY_MAIN, TONY, 'hello')
    const controller = new AbortController()
    controller.abort()
    expect(
      await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: controller.signal }),
    ).toBeNull()
    expect(h.llm.calls).toBe(0)
  })
})

import { describe, expect, test } from 'bun:test'
import { MISSION, PEPPER, TONY, TONY_MAIN } from '../testing/fixture.ts'
import { createReflectionHarness, jsonTurn, promptText } from '../testing/reflect.ts'

const signal = () => new AbortController().signal

describe('reflection privacy', () => {
  test("I-4: a memory reflected from Tony's direct thread is not returned by recall or core for Pepper", async () => {
    const h = await createReflectionHarness({
      script: [
        jsonTurn({
          facts: [
            { content: "Tony's sister Maria is visiting on Friday.", about: TONY },
            { content: 'The surprise party for Maria is on Friday.', about: null },
          ],
          notes: [],
        }),
      ],
    })
    await h.say(TONY_MAIN, TONY, 'My sister Maria visits Friday; I am planning her surprise party.')
    const result = await h.reflection.reflector.reflect({ threadId: TONY_MAIN, signal: signal() })
    expect(result?.written).toHaveLength(2)
    // Pin them, as a later live turn could, so core() has something to show.
    for (const id of result?.written ?? []) await h.memories.update(id, { pinned: true })

    const pepper = { participants: [PEPPER] }
    const mission = { participants: [TONY, PEPPER] }
    const tony = { participants: [TONY] }
    for (const viewer of [pepper, mission]) {
      expect(await h.memory.recall({ text: 'Maria sister party Friday', viewer })).toEqual([])
      expect(await h.memory.core(viewer)).toEqual([])
    }
    expect(await h.memory.recall({ text: 'Maria sister party Friday', viewer: tony })).toHaveLength(2)
    expect(await h.memory.core(tony)).toHaveLength(2)
  })

  test('I-3: the reflection prompts for a group thread never contain memories a participant cannot see', async () => {
    const h = await createReflectionHarness({
      script: [
        jsonTurn({ facts: [{ content: "Tony's dog Dummy needs a vet visit.", about: TONY }], notes: [] }),
        jsonTurn({ decisions: [{ candidate: 1, action: 'new' }] }),
      ],
    })
    // Same words in every scope. Only the MISSION one is visible to both Tony and Pepper.
    const visible = await h.seedMemory(1, {
      content: "Tony's dog Dummy had a vet visit in May.",
      visibility: 'thread',
      threadId: MISSION,
      subjectPersonId: TONY,
    })
    const hidden = [
      await h.seedMemory(2, {
        content: "PRIVATE-A Tony's dog Dummy vet bill.",
        visibility: 'subject',
        subjectPersonId: TONY,
        threadId: TONY_MAIN,
      }),
      await h.seedMemory(3, {
        content: "PRIVATE-B Tony's dog Dummy vet worries.",
        visibility: 'thread',
        threadId: TONY_MAIN,
        subjectPersonId: TONY,
      }),
      await h.seedMemory(4, {
        content: "PRIVATE-C Pepper thinks Tony's dog Dummy needs a vet.",
        visibility: 'subject',
        subjectPersonId: PEPPER,
      }),
      await h.seedMemory(5, {
        content: "PRIVATE-D Tony's dog Dummy vet is owner-only.",
        visibility: 'owner',
      }),
    ]
    // A storage bug that ignores the filter must not leak either (defense in depth).
    h.memories.ignoreFilter = true
    await h.say(MISSION, TONY, 'Dummy needs to see the vet.')
    await h.reflection.reflector.reflect({ threadId: MISSION, signal: signal() })

    expect(h.llm.requests).toHaveLength(2)
    const prompts = h.llm.requests.map(promptText).join('\n')
    expect(prompts).toContain(visible.id)
    for (const m of hidden) {
      expect(prompts).not.toContain(m.id)
      expect(prompts).not.toContain(m.content.slice(0, 9))
    }
    expect(h.log.entries.some((e) => e.level === 'warn' && e.msg.includes('outside the scope'))).toBe(true)
  })

  test("I-3: the extract prompt holds only this thread's messages", async () => {
    const h = await createReflectionHarness({ script: [jsonTurn({ facts: [], notes: [] })] })
    await h.say(TONY_MAIN, TONY, 'OTHER-THREAD-SECRET')
    await h.say(MISSION, PEPPER, 'Mission update.')
    await h.reflection.reflector.reflect({ threadId: MISSION, signal: signal() })
    const prompt = promptText(h.llm.requests[0] as NonNullable<(typeof h.llm.requests)[0]>)
    expect(prompt).toContain('Mission update.')
    expect(prompt).not.toContain('OTHER-THREAD-SECRET')
  })
})

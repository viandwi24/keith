import { expect, test } from 'bun:test'
import { createAddressing } from './index.ts'
import {
  CAST,
  createAddressingHarness,
  MISSION,
  mindConfig,
  PEPPER,
  replyTurn,
  transcript,
} from './testing.ts'

const signal = () => new AbortController().signal

test('a rule verdict is final: the model is not called', async () => {
  const h = createAddressingHarness()
  const verdict = await h.detector.decide({
    threadId: MISSION,
    input: { authorPersonId: PEPPER, text: 'Keith, are you there?' },
    recent: [],
    participantNames: CAST,
    signal: signal(),
  })
  expect(verdict).toEqual({ addressed: true, by: 'name' })
  expect(h.llm.calls).toBe(0)
})

test('an unsure input goes to the classifier with "rules+utility"', async () => {
  const h = createAddressingHarness({ script: [replyTurn({ addressed: true, confidence: 0.9 })] })
  const verdict = await h.detector.decide({
    threadId: MISSION,
    input: { authorPersonId: PEPPER, text: 'find us a quiet place' },
    recent: transcript([['tony', 'we need a venue']]),
    participantNames: CAST,
    signal: signal(),
  })
  expect(verdict).toEqual({ addressed: true, by: 'classifier' })
  expect(h.scheduler.lanes).toEqual(['foreground'])
})

test('with "rules" an unsure input stays unsure and no model is called', async () => {
  const h = createAddressingHarness({ addressing: 'rules' })
  const verdict = await h.detector.decide({
    threadId: MISSION,
    input: { authorPersonId: PEPPER, text: 'find us a quiet place' },
    recent: [],
    participantNames: CAST,
    signal: signal(),
  })
  expect(verdict).toEqual({ addressed: false, by: 'unsure' })
  expect(h.runLoop.calls).toHaveLength(0)
})

test('decide never throws: a failing rule pass or run loop is unsure', async () => {
  const h = createAddressingHarness()
  const detector = createAddressing({
    ...h.deps,
    config: mindConfig(),
    runLoop: async () => {
      throw new Error('boom')
    },
  })
  const unsure = await detector.decide({
    threadId: MISSION,
    input: { authorPersonId: PEPPER, text: 'lol' },
    recent: [],
    participantNames: CAST,
    signal: signal(),
  })
  expect(unsure).toEqual({ addressed: false, by: 'unsure' })

  const broken = await detector.decide({
    threadId: MISSION,
    input: { authorPersonId: PEPPER, text: 'lol' },
    recent: [{ role: 'user' } as never],
    participantNames: CAST,
    signal: signal(),
  })
  expect(broken).toEqual({ addressed: false, by: 'unsure' })
  expect(h.log.entries.filter((e) => e.level === 'warn')).toHaveLength(2)
})

import { describe, expect, test } from 'bun:test'
import { ProviderError } from '@keith/sdk'
import type { RunLoop } from '../types.ts'
import { CLASSIFIER_TIMEOUT_MS, type ClassifierInput, classify } from './classifier.ts'
import { ADDRESSING_SYSTEM_PROMPT } from './prompts.ts'
import {
  CAST,
  createAddressingHarness,
  MISSION,
  message,
  PEPPER,
  RHODEY,
  replyTurn,
  TONY,
} from './testing.ts'

function input(over: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    threadId: MISSION,
    input: { authorPersonId: TONY, text: 'do it now' },
    recent: [message(1, PEPPER, 'we need a venue'), message(2, null, 'I found two venues.')],
    participantNames: CAST,
    signal: new AbortController().signal,
    ...over,
  }
}

describe('classifier: the call', () => {
  test('one utility step, no tools, no persistence, in the foreground lane, for the thread and its participants', async () => {
    const h = createAddressingHarness({ script: [replyTurn({ addressed: true, confidence: 0.9 })] })
    const verdict = await classify(h.deps, input())
    expect(verdict).toEqual({ addressed: true, by: 'classifier' })
    expect(h.scheduler.lanes).toEqual(['foreground'])
    expect(h.runLoop.calls).toHaveLength(1)
    expect(h.runLoop.calls[0]).toMatchObject({
      tools: [],
      modelRole: 'utility',
      maxSteps: 1,
      persist: null,
      runCtx: { personId: TONY, participants: [TONY, PEPPER], threadId: MISSION, taskId: null },
    })
  })

  test('the request holds only the name, the participants, the last ten visible messages and the input', async () => {
    const h = createAddressingHarness({ script: [replyTurn({ addressed: false, confidence: 0.95 })] })
    const recent = Array.from({ length: 15 }, (_, i) =>
      i % 2 === 0
        ? message(i + 1, RHODEY, `human line ${i + 1}`)
        : message(i + 1, null, `mind line ${i + 1}`),
    )
    recent.push(message(16, null, 'tool output that nobody sees', 'tool'))
    const verdict = await classify(h.deps, input({ recent }))
    expect(verdict).toEqual({ addressed: false, by: 'classifier' })

    const [req] = h.llm.requests
    expect(req?.tools ?? []).toEqual([])
    expect(req?.system).toBe(ADDRESSING_SYSTEM_PROMPT.replaceAll('{name}', 'Keith'))
    expect(req?.messages).toHaveLength(1)
    const content = String(req?.messages[0]?.content)
    expect(content).toContain('Assistant: Keith')
    expect(content).toContain('Participants: Tony, Pepper, Rhodey')
    for (let i = 1; i <= 5; i++) expect(content).not.toContain(`line ${i}\n`)
    for (let i = 6; i <= 15; i++) expect(content).toContain(`line ${i}`)
    expect(content).toContain('Person A: human line 7')
    expect(content).toContain('Keith: mind line 6')
    expect(content).not.toContain('tool output')
    expect(content).toMatch(/Latest message, from Person B:\ndo it now$/)
  })

  test('a reply in a code fence or with text around it is accepted', async () => {
    const h = createAddressingHarness({
      script: [replyTurn('Sure.\n```json\n{"addressed": true, "confidence": 0.8}\n```')],
    })
    expect(await classify(h.deps, input())).toEqual({ addressed: true, by: 'classifier' })
  })
})

describe('classifier: failures are unsure (not addressed), logged without text', () => {
  test('low confidence', async () => {
    const h = createAddressingHarness({ script: [replyTurn({ addressed: true, confidence: 0.69 })] })
    expect(await classify(h.deps, input())).toEqual({ addressed: false, by: 'unsure' })
    const h2 = createAddressingHarness({ script: [replyTurn({ addressed: false, confidence: 0.3 })] })
    expect(await classify(h2.deps, input())).toEqual({ addressed: false, by: 'unsure' })
  })

  test('the threshold is inclusive', async () => {
    const h = createAddressingHarness({ script: [replyTurn({ addressed: true, confidence: 0.7 })] })
    expect(await classify(h.deps, input())).toEqual({ addressed: true, by: 'classifier' })
  })

  test.each([
    ['not JSON', 'yes, it is for Keith'],
    ['broken JSON', '{"addressed": true, "confidence": }'],
    ['wrong types', '{"addressed": "yes", "confidence": 0.9}'],
    ['confidence out of range', '{"addressed": true, "confidence": 7}'],
    ['a missing field', '{"addressed": true}'],
  ])('an invalid reply (%s)', async (_, text) => {
    const h = createAddressingHarness({ script: [replyTurn(text)] })
    expect(await classify(h.deps, input())).toEqual({ addressed: false, by: 'unsure' })
    expect(h.log.entries).toContainEqual({
      level: 'warn',
      msg: 'addressing classifier gave no answer',
      fields: { threadId: MISSION, reason: 'invalid_reply' },
    })
  })

  test('a timeout aborts the call', async () => {
    const h = createAddressingHarness({
      script: [[{ delay: 60_000 }, ...replyTurn({ addressed: true, confidence: 1 })]],
    })
    const started = Date.now()
    expect(await classify(h.deps, input(), { timeoutMs: 20 })).toEqual({ addressed: false, by: 'unsure' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(h.runLoop.calls[0]?.signal.aborted).toBe(true)
    expect(h.log.entries.at(-1)?.fields).toEqual({ threadId: MISSION, reason: 'timeout' })
  })

  test('a timeout returns even when the run loop ignores the abort', async () => {
    const h = createAddressingHarness()
    const stuck: RunLoop = () => new Promise(() => {})
    const verdict = await classify({ ...h.deps, runLoop: stuck }, input(), { timeoutMs: 20 })
    expect(verdict).toEqual({ addressed: false, by: 'unsure' })
  })

  test('the default timeout is 5 s', () => {
    expect(CLASSIFIER_TIMEOUT_MS).toBe(5_000)
  })

  test('a provider error', async () => {
    const h = createAddressingHarness({
      script: [
        () => {
          throw new ProviderError('unavailable', 'upstream down')
        },
      ],
    })
    expect(await classify(h.deps, input())).toEqual({ addressed: false, by: 'unsure' })
    expect(h.log.entries.at(-1)).toMatchObject({
      level: 'warn',
      fields: { reason: 'error', error: 'PROVIDER_ERROR' },
    })
  })

  test("the caller's abort", async () => {
    const h = createAddressingHarness({
      script: [[{ delay: 60_000 }, ...replyTurn({ addressed: true, confidence: 1 })]],
    })
    const ctrl = new AbortController()
    const pending = classify(h.deps, input({ signal: ctrl.signal }))
    await Bun.sleep(5)
    ctrl.abort()
    expect(await pending).toEqual({ addressed: false, by: 'unsure' })
    expect(h.log.entries.at(-1)?.fields).toEqual({ threadId: MISSION, reason: 'aborted' })
  })

  test('already aborted: the scheduler refuses the job', async () => {
    const h = createAddressingHarness()
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await classify(h.deps, input({ signal: ctrl.signal }))).toEqual({ addressed: false, by: 'unsure' })
    expect(h.llm.calls).toBe(0)
  })

  test('no log line carries message text', async () => {
    const h = createAddressingHarness({ script: [replyTurn('secret launch codes')] })
    await classify(h.deps, input({ input: { authorPersonId: TONY, text: 'the vault code is 1234' } }))
    const logged = JSON.stringify(h.log.entries)
    expect(logged).not.toContain('1234')
    expect(logged).not.toContain('secret')
    expect(logged).not.toContain('venue')
  })
})

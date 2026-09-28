import { describe, expect, test } from 'bun:test'
import { CORPUS, type CorpusLine } from './corpus.ts'
import { decideByRules } from './rules.ts'
import { CAST, createAddressingHarness, MISSION, replyTurn, SPEAKERS, transcript } from './testing.ts'

function args(line: CorpusLine) {
  const author = SPEAKERS[line.author]
  if (author === null) throw new Error('a corpus input has a human author')
  return {
    threadId: MISSION,
    input: { authorPersonId: author, text: line.text },
    recent: transcript(line.recent),
    participantNames: line.participants ?? CAST,
    signal: new AbortController().signal,
  }
}

describe('addressing corpus', () => {
  test('has at least 40 lines, unique ids, and covers every kind of line', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(40)
    expect(new Set(CORPUS.map((l) => l.id)).size).toBe(CORPUS.length)
    const kinds = new Set(CORPUS.map((l) => l.by))
    for (const by of ['single_human', 'name', 'other_human', 'reply', 'question', 'unsure'] as const)
      expect(kinds).toContain(by)
    expect(CORPUS.some((l) => l.text.includes('@keith'))).toBe(true)
    expect(CORPUS.some((l) => l.by === 'unsure' && l.addressed)).toBe(true)
    expect(CORPUS.some((l) => l.by === 'unsure' && !l.addressed)).toBe(true)
  })

  test('a rule verdict agrees with the truth', () => {
    for (const line of CORPUS.filter((l) => l.by !== 'unsure')) {
      expect({ id: line.id, addressed: line.addressed }).toEqual({
        id: line.id,
        addressed: line.by !== 'other_human',
      })
    }
  })

  test.each(CORPUS.map((l) => [l.id, l] as const))('rules alone: %s', (_, line) => {
    const a = args(line)
    const verdict = decideByRules({
      mindName: 'Keith',
      input: a.input,
      recent: a.recent,
      participantNames: a.participantNames,
    })
    expect(verdict.by).toBe(line.by)
    // Every non-ambiguous line is right without the classifier; unsure lines are not addressed.
    if (line.by !== 'unsure' || !line.addressed) expect(verdict.addressed).toBe(line.addressed)
  })

  test.each(CORPUS.map((l) => [l.id, l] as const))(
    'rules + utility answering by the label: %s',
    async (_, line) => {
      const h = createAddressingHarness({
        script: [replyTurn({ addressed: line.addressed, confidence: 0.9 })],
      })
      const verdict = await h.detector.decide(args(line))
      expect(verdict.addressed).toBe(line.addressed)
      // Exactly the unsure lines reach the classifier.
      expect(h.llm.calls).toBe(line.by === 'unsure' ? 1 : 0)
      expect(verdict.by).toBe(line.by === 'unsure' ? 'classifier' : line.by)
    },
  )

  test('with addressing = "rules", no line calls the model', async () => {
    const h = createAddressingHarness({ addressing: 'rules' })
    for (const line of CORPUS) {
      const verdict = await h.detector.decide(args(line))
      expect(verdict.by).toBe(line.by)
    }
    expect(h.llm.calls).toBe(0)
    expect(h.runLoop.calls).toHaveLength(0)
    expect(h.scheduler.lanes).toHaveLength(0)
  })
})

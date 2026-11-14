// What the dreaming service reports (P35.6.1): the audit rows and the dream phase events, the crash and failure paths, and the
// notices sent to the person. The setup is in service-test-kit.ts; service.test.ts holds the run modes, the cadence and the budget.
import { describe, expect, test } from 'bun:test'
import { frontSessionId } from '../../../platform/sessions.ts'
import { RECENT_TIER, writeMemoryFile } from './files.ts'
import { DREAM_FAILED_TEXT } from './service.ts'
import { keepJudge, OTHER, PERSON, SECRET_WORD, serviceKit } from './service-test-kit.ts'

const kit = serviceKit()

describe('audit and events', () => {
  test('audit rows and events hold counts and ids only, never the text or the reason', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant([`${SECRET_WORD} one`, `${SECRET_WORD} two`])
    await kit.service().run(PERSON, 'schedule')
    const run = kit.audits.find((a) => a.kind === 'dream.run')
    expect(run?.detail).toMatchObject({
      subject: PERSON,
      mode: 'auto',
      trigger: 'schedule',
      status: 'applied',
    })
    expect(JSON.stringify(kit.audits)).not.toContain(SECRET_WORD)
    expect(JSON.stringify(kit.audits)).not.toContain('said today')
    expect(JSON.stringify(kit.events)).not.toContain(SECRET_WORD)
    expect(kit.events.map((e) => e.type)).toEqual([
      'brain.hippocampus.dream',
      'brain.hippocampus.dream',
    ])
    expect(kit.events.map((e) => e.payload.phase)).toEqual(['start', 'end'])
  })

  test('a refused run writes its audit row and no event', async () => {
    const result = await kit.service().run(PERSON, 'schedule')
    expect(result.reason).toBe('off')
    expect(kit.audits).toHaveLength(1)
    expect(kit.audits[0]).toMatchObject({
      kind: 'dream.run',
      detail: { status: 'refused', reason: 'off' },
    })
    expect(kit.events).toHaveLength(0)
  })
})

describe('crash and failures', () => {
  test('a crash between judge and apply leaves the cursor and the files unchanged; the next run collects the same messages', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers', 'Flat key is in the blue box'])
    const crashed = await kit
      .service({
        applier: () => {
          throw new Error('boom')
        },
      })
      .run(PERSON, 'schedule')
    expect(crashed.status).toBe('failed')
    expect(kit.repo.cursorOf(PERSON)).toBeUndefined()
    expect(kit.recent()).toBeUndefined()
    expect(kit.profile()).toBeUndefined()

    const again = await kit.service().run(PERSON, 'schedule')
    expect(again.status).toBe('applied')
    expect(again.counts.candidates).toBe(2)
  })

  test('a judge output that is not a plan fails the run with reason judge, and writes only a note', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    const result = await kit
      .service({
        judge: async () => ({ ok: false, reason: 'judge-output', cause: 'bad-plan' }),
      })
      .run(PERSON, 'schedule')
    expect(result).toMatchObject({ status: 'failed', reason: 'judge' })
    expect(kit.service().diary(PERSON)?.text).toContain('run failed: judge')
    expect(kit.recent()).toBeUndefined()
    // the cursor stays where it was (nothing collected yet): the run keeps the batch it failed on, for one retry
    expect(kit.repo.cursorOf(PERSON)).toEqual({})
  })

  test('a failed batch is retried once; the second failure of the same batch skips it and advances the cursor', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers', 'I live in Bandung'])
    let calls = 0
    const judge = async (...args: Parameters<typeof keepJudge>) => {
      calls++
      if (calls <= 2)
        return {
          ok: false as const,
          reason: 'judge-output' as const,
          cause: 'empty-reply' as const,
        }
      return keepJudge(...args)
    }
    const svc = kit.service({ judge })
    expect(await svc.run(PERSON, 'schedule')).toMatchObject({ status: 'failed', reason: 'judge' })
    expect(kit.repo.failedBatchOf(PERSON)).toHaveLength(2)
    const second = await svc.run(PERSON, 'schedule')
    expect(second).toMatchObject({ status: 'failed', reason: 'judge', counts: { candidates: 0 } })
    expect(svc.diary(PERSON)?.text).toContain(
      'dropped.failed: 2 candidates were skipped after two failed judgements; nothing was changed',
    )
    expect(kit.repo.failedBatchOf(PERSON)).toBeUndefined()
    expect(kit.repo.cursorOf(PERSON)).toEqual({ [frontSessionId(PERSON, 0)]: 'm0002' })
    expect(kit.recent()).toBeUndefined()
    // nothing new after the skipped batch: no model call
    expect((await svc.run(PERSON, 'schedule')).status).toBe('skipped')
    expect(calls).toBe(2)
    // a new message is judged normally: a successful run resets the failure memory
    kit.plant(['I prefer tea'])
    const fourth = await svc.run(PERSON, 'schedule')
    expect(fourth).toMatchObject({ status: 'applied', counts: { candidates: 1 } })
    expect(calls).toBe(3)
    expect(kit.repo.failedBatchOf(PERSON)).toBeUndefined()
  })

  test('one failed judgement and a successful retry apply the whole batch, with no skip', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers', 'I live in Bandung'])
    let calls = 0
    const judge = async (...args: Parameters<typeof keepJudge>) => {
      calls++
      if (calls === 1)
        return { ok: false as const, reason: 'judge-output' as const, cause: 'bad-plan' as const }
      return keepJudge(...args)
    }
    const svc = kit.service({ judge })
    expect(await svc.run(PERSON, 'schedule')).toMatchObject({ status: 'failed' })
    const retry = await svc.run(PERSON, 'schedule')
    expect(retry).toMatchObject({ status: 'applied', counts: { candidates: 2 } })
    expect(svc.diary(PERSON)?.text).not.toContain('dropped.failed')
    expect(kit.repo.cursorOf(PERSON)).toEqual({ [frontSessionId(PERSON, 0)]: 'm0002' })
    expect(kit.repo.failedBatchOf(PERSON)).toBeUndefined()
  })

  test('no model and the budget cap refuse the run', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    const noModel = await kit
      .service({
        judge: async () => ({ ok: false, reason: 'no-model', cause: 'no-model' }),
      })
      .run(PERSON, 'schedule')
    expect(noModel).toMatchObject({ status: 'refused', reason: 'no-model' })
    const budget = await kit
      .service({
        judge: async () => ({ ok: false, reason: 'budget', cause: 'budget-cap' }),
      })
      .run(PERSON, 'schedule')
    expect(budget).toMatchObject({ status: 'refused', reason: 'budget' })
  })

  test('mode off refuses with off and makes no run row', async () => {
    kit.repo.setMode(PERSON, 'off', PERSON)
    kit.plant(['I like short answers'])
    const result = await kit.service().run(PERSON, 'manual')
    expect(result).toMatchObject({ status: 'refused', reason: 'off', runId: null })
    expect(kit.repo.listRuns(PERSON)).toHaveLength(0)
    expect(kit.recent()).toBeUndefined()
  })
})

describe('notices of an auto run and a failed run (P35.6.1)', () => {
  type Sent = { id: string; to: string; text: string; name: string }
  const sink =
    (sent: Sent[]) => async (request: { id: string; to: string; text: string; name: string }) => {
      sent.push({ id: request.id, to: request.to, text: request.text, name: request.name })
      return { status: 'delivered' }
    }

  test('an auto run that wrote tells the person once, with counts and no entry text', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    const sent: Sent[] = []
    const result = await kit.service({ deliver: sink(sent) }).run(PERSON, 'schedule')
    expect(result.status).toBe('applied')
    expect(sent).toEqual([
      {
        id: `dream:${result.runId}:auto`,
        to: PERSON,
        name: 'dreaming.notice',
        text: 'Memory dreaming wrote 1 changes to your memory.',
      },
    ])
    expect(sent[0]?.text).not.toContain('I like short answers')
  })

  test('an auto run that held units back says so with the count of held changes', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    const sent: Sent[] = []
    const svc = kit.service({
      deliver: sink(sent),
      judge: async (personId, candidates) => {
        writeMemoryFile(kit.dataDir, PERSON, RECENT_TIER, '- Typed during the judge\n')
        return keepJudge(personId, candidates)
      },
    })
    const result = await svc.run(PERSON, 'schedule')
    expect(result.staged).toBe(true)
    expect(sent.map((s) => s.text)).toEqual([
      'Memory dreaming held 1 changes for review. Nothing in your memory changed for them yet. Run /dream apply to write them.',
    ])
  })

  test('a run that writes nothing sends no auto notice', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    const sent: Sent[] = []
    await kit
      .service({
        deliver: sink(sent),
        judge: async () => ({ ok: true, plan: { candidates: [] } }),
      })
      .run(PERSON, 'schedule')
    expect(sent).toEqual([])
  })

  test('a judge reply that is not a plan tells the person once that the run failed', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    const sent: Sent[] = []
    const result = await kit
      .service({
        deliver: sink(sent),
        judge: async () => ({ ok: false, reason: 'judge-output', cause: 'bad-plan' }),
      })
      .run(PERSON, 'schedule')
    expect(result.status).toBe('failed')
    expect(sent).toEqual([
      {
        id: `dream:${result.runId}:failed`,
        to: PERSON,
        name: 'dreaming.notice',
        text: DREAM_FAILED_TEXT,
      },
    ])
  })

  test('an unexpected error in the run tells the person once that the run failed', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    const sent: Sent[] = []
    const result = await kit
      .service({
        deliver: sink(sent),
        judge: async () => {
          throw new Error('boom')
        },
      })
      .run(PERSON, 'schedule')
    expect(result.status).toBe('failed')
    expect(sent.map((s) => s.id)).toEqual([`dream:${result.runId}:failed`])
  })
})

describe('dream phase events (P35.6.1)', () => {
  const dreamEvents = () => kit.events.filter((e) => e.type === 'brain.hippocampus.dream')

  test('a run writes one start before the judge reads, and one end with its counts, on the person’s front session', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    const seenByJudge: number[] = []
    const svc = kit.service({
      judge: async (personId, candidates) => {
        seenByJudge.push(dreamEvents().length)
        return keepJudge(personId, candidates)
      },
    })
    const result = await svc.run(PERSON, 'manual')
    // the start was written before the judge turn
    expect(seenByJudge).toEqual([1])
    const [start, end] = dreamEvents()
    // the start carries the count the run reviews (collected before the start), the other counts are zero
    expect(start?.payload).toMatchObject({
      region: 'hippocampus',
      phase: 'start',
      trigger: 'manual',
      runId: result.runId,
      candidates: 1,
      promoted: 0,
      applied: false,
    })
    expect(end?.payload).toMatchObject({
      phase: 'end',
      trigger: 'manual',
      runId: result.runId,
      candidates: 1,
      applied: true,
    })
    for (const event of dreamEvents()) expect(event.sessionId).toBe(frontSessionId(PERSON, 0))
  })

  test('a failed run ends too: the start and the end are paired, the end is not applied', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    const result = await kit
      .service({
        judge: async () => ({ ok: false, reason: 'judge-output', cause: 'bad-plan' }),
      })
      .run(PERSON, 'schedule')
    expect(result.status).toBe('failed')
    expect(dreamEvents().map((e) => e.payload.phase)).toEqual(['start', 'end'])
    // the end names how the run ended and why (a closed code, no text)
    expect(dreamEvents()[1]?.payload).toMatchObject({
      runId: result.runId,
      applied: false,
      status: 'failed',
      reason: 'judge',
    })
  })

  test('a run with nothing new is skipped and still paired; a run that is refused before its row writes no event', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    await kit.service().run(PERSON, 'schedule')
    expect(dreamEvents().map((e) => e.payload.phase)).toEqual(['start', 'end'])
    kit.events.length = 0
    kit.repo.setMode(PERSON, 'off', PERSON)
    await kit.service().run(PERSON, 'schedule')
    expect(dreamEvents()).toHaveLength(0)
  })

  test('a run of another person writes to that person’s session only', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.repo.setMode(OTHER, 'auto', OTHER)
    kit.plant(['I like short answers'])
    await kit.service().run(PERSON, 'schedule')
    const mine = dreamEvents().map((e) => e.sessionId)
    kit.events.length = 0
    await kit.service().run(OTHER, 'manual')
    const theirs = dreamEvents().map((e) => e.sessionId)
    expect(mine.every((id) => id === frontSessionId(PERSON, 0))).toBe(true)
    expect(theirs.every((id) => id === frontSessionId(OTHER, 0))).toBe(true)
  })
})

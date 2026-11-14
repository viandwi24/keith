// The dreaming service (P35.4.3): a run's modes, the cadence of a schedule and a manual run, and the budget refusal. The judge is a
// fake that keeps every candidate as a short-term fact, so the files show what the applier did. The apply, the status and the staged
// plan live in service-apply.test.ts; the audit rows, events and failures in service-events.test.ts; the setup in service-test-kit.ts.
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { FRONT_TURN_BUDGET_USD } from '../../budget/index.ts'
import { dayOf } from './collect.ts'
import { stagedFileOf } from './files.ts'
import type { JudgeCandidate } from './prompt.ts'
import {
  budgetLowAt,
  DreamForbidden,
  DreamRefused,
  dreamBudgetTextOf,
  TOO_SOON_MS,
} from './service.ts'
import { DAY, keepJudge, OTHER, PERSON, serviceKit, T0 } from './service-test-kit.ts'

const kit = serviceKit()

describe('run in propose', () => {
  test('propose writes the staged plan and no memory file (the diary is the only file written)', async () => {
    kit.repo.setMode(PERSON, 'propose', PERSON)
    kit.plant(['I like short answers', 'Flat key is in the blue box'])
    const result = await kit.service().run(PERSON, 'schedule')
    expect(result.status).toBe('staged')
    expect(result.applied).toBe(false)
    expect(result.staged).toBe(true)
    expect(kit.recent()).toBeUndefined()
    expect(kit.profile()).toBeUndefined()
    expect(existsSync(stagedFileOf(kit.dataDir, PERSON, result.runId ?? ''))).toBe(true)
    expect(kit.service().diary(PERSON)?.text).toContain('proposed kept')
    expect(kit.repo.cursorOf(PERSON)).toBeDefined()
  })

  test('a run with no new messages is skipped and calls no judge', async () => {
    kit.repo.setMode(PERSON, 'propose', PERSON)
    let calls = 0
    const result = await kit
      .service({
        judge: async () => {
          calls += 1
          return { ok: false, reason: 'turn-error', cause: 'model-error' }
        },
      })
      .run(PERSON, 'schedule')
    expect(result.status).toBe('skipped')
    expect(calls).toBe(0)
  })
})

describe('run in auto', () => {
  test('auto writes the memory and keeps an undo for seven days', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    const result = await kit.service().run(PERSON, 'manual')
    expect(result.status).toBe('applied')
    expect(result.applied).toBe(true)
    expect(kit.recent()).toContain('- I like short answers')
    expect(kit.repo.listRuns(PERSON)[0]?.undoUntil).toBe(T0 + 7 * 24 * 60 * 60 * 1000)

    const undone = kit.service().undo(PERSON)
    expect(undone.restored).toBe(0)
    expect(kit.recent()).toBeUndefined()
  })

  test('the undo window closes after seven days', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    await kit.service().run(PERSON, 'manual')
    kit.clock += 7 * 24 * 60 * 60 * 1000 + 1
    expect(() => kit.service().undo(PERSON)).toThrow(DreamRefused)
    expect(kit.recent()).toContain('- I like short answers')
  })
})

describe('modes, status and the diary', () => {
  test('a person sets only their own mode; the change is audited with from and to', async () => {
    const svc = kit.service()
    await expect(svc.setMode(PERSON, PERSON, 'propose')).resolves.toBe('propose')
    expect(kit.repo.getMode(PERSON)).toBe('propose')
    await expect(svc.setMode(OTHER, PERSON, 'auto')).rejects.toBeInstanceOf(DreamForbidden)
    expect(kit.repo.getMode(PERSON)).toBe('propose')
    expect(kit.audits.find((a) => a.kind === 'dream.mode')?.detail).toEqual({
      subject: PERSON,
      from: 'off',
      to: 'propose',
    })
  })

  test('the owner defaults to propose and a member to the member default', async () => {
    const owner = await kit.service({ owner: { isOwner: async () => true } }).status(PERSON)
    expect(owner.mode).toBe('propose')
    const member = await kit.service().status(PERSON)
    expect(member.mode).toBe('off')
  })

  test('status shows the staged plan to apply and the next start after a run', async () => {
    kit.repo.setMode(PERSON, 'propose', PERSON)
    kit.plant(['I like short answers'])
    const svc = kit.service()
    await svc.run(PERSON, 'schedule')
    const status = await svc.status(PERSON)
    expect(status.canApply).toBe(true)
    expect(status.nextRunAt).toBe(T0 + TOO_SOON_MS)
    kit.clock = T0 + DAY
    expect((await kit.service().status(PERSON)).nextRunAt).toBeNull()
  })

  test('the diary of a day is its latest file by default', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    await kit.service().run(PERSON, 'schedule')
    const diary = kit.service().diary(PERSON)
    expect(diary?.date).toBe(dayOf(T0))
    expect(diary?.text).toContain('# Dreams')
    expect(kit.service().diary(PERSON, '2000-01-01')).toBeUndefined()
  })
})

describe('manual run (runNow, P35.5.3)', () => {
  test('a manual run 3 hours after a schedule run is too-soon: no judge call, a refusal audit row, no run row', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    await kit.service().run(PERSON, 'schedule')
    kit.clock = T0 + 3 * 60 * 60 * 1000
    kit.plant(['A second thing to keep'])
    let calls = 0
    const svc = kit.service({
      judge: async (p, c) => {
        calls += 1
        return keepJudge(p, c)
      },
    })
    const rowsBefore = kit.repo.listRuns(PERSON).length
    let thrown: unknown
    try {
      await svc.runNow(PERSON)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DreamRefused)
    expect((thrown as DreamRefused).reason).toBe('too-soon')
    expect(calls).toBe(0)
    expect(kit.repo.listRuns(PERSON).length).toBe(rowsBefore)
    expect(kit.audits.at(-1)).toMatchObject({
      kind: 'dream.run',
      detail: { trigger: 'manual', status: 'refused', reason: 'too-soon' },
    })
  })

  test('a manual run at 25 hours after the schedule run starts and calls the judge', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    await kit.service().run(PERSON, 'schedule')
    kit.clock = T0 + 25 * 60 * 60 * 1000
    kit.plant(['A second thing to keep'])
    let calls = 0
    const svc = kit.service({
      judge: async (p, c) => {
        calls += 1
        return keepJudge(p, c)
      },
    })
    const result = await svc.runNow(PERSON)
    expect(result.status).toBe('applied')
    expect(result.runId).not.toBeNull()
    expect(calls).toBe(1)
    expect(kit.repo.listRuns(PERSON)[0]?.trigger).toBe('manual')
  })

  test('a manual run needs no five-message minimum: one new message is enough', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['only one new message'])
    const result = await kit.service().runNow(PERSON)
    expect(result.status).toBe('applied')
  })
})

describe('budget refusal (P35.5.4)', () => {
  test('a run that would leave the person less than the judge reservation plus a margin is skipped as budget-low: no judge call, no notice, the cursor stays', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    const calls: string[] = []
    const sent: string[] = []
    const judge = async (p: string, c: readonly JudgeCandidate[]) => {
      calls.push(p)
      return keepJudge(p, c)
    }
    const deliver = async (request: { text: string }) => {
      sent.push(request.text)
      return { status: 'delivered' as const }
    }
    // maxUsdPerRun is 0.05 here: the run needs the reservation plus one whole chat turn left (0.05 + 0.5)
    expect(budgetLowAt(0.05)).toBeCloseTo(0.05 + FRONT_TURN_BUDGET_USD)
    const low = await kit
      .service({ judge, deliver, budgetRemaining: () => 0.5 })
      .run(PERSON, 'schedule')
    expect(low).toMatchObject({ status: 'skipped', reason: 'budget-low' })
    expect(calls).toEqual([])
    expect(sent).toEqual([])
    expect(kit.repo.cursorOf(PERSON)).toBeUndefined()
    expect(kit.repo.listRuns(PERSON)[0]).toMatchObject({ status: 'skipped', reason: 'budget-low' })
    // the same messages, with room left: the run calls the judge and applies
    const normal = await kit
      .service({ judge, deliver, budgetRemaining: () => 0.6 })
      .run(PERSON, 'schedule')
    expect(normal.reason).not.toBe('budget-low')
    expect(calls).toEqual([PERSON])
    // no limit (null) runs too; the first run took the messages, so there is one new one to judge
    kit.plant(['I prefer tea'])
    await kit.service({ judge, deliver, budgetRemaining: () => null }).run(PERSON, 'manual')
    expect(calls).toEqual([PERSON, PERSON])
  })

  test('a judge turn over the cap ends refused:budget, keeps the cursor and the files, and tells the person once', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    const sent: { id: string; to: string; text: string }[] = []
    const svc = kit.service({
      judge: async () => ({ ok: false, reason: 'budget', cause: 'budget-cap' }),
      deliver: async (request) => {
        sent.push({ id: request.id, to: request.to, text: request.text })
        return { status: 'delivered' }
      },
    })
    const result = await svc.run(PERSON, 'schedule')
    expect(result.status).toBe('refused')
    expect(result.reason).toBe('budget')
    expect(kit.repo.cursorOf(PERSON)).toBeUndefined()
    expect(kit.recent()).toBeUndefined()
    expect(sent).toEqual([
      { id: `dream:${result.runId}:budget`, to: PERSON, text: dreamBudgetTextOf(0.05) },
    ])
  })

  test('the notice is not sent for other refusals, and carries no entry text', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    let sent = 0
    await kit
      .service({
        judge: async () => ({ ok: false, reason: 'no-model', cause: 'no-model' }),
        deliver: async () => {
          sent += 1
          return { status: 'delivered' }
        },
      })
      .run(PERSON, 'schedule')
    expect(sent).toBe(0)
    const text = dreamBudgetTextOf(0.05)
    expect(text).not.toContain('I like short answers')
    expect(text).toContain('cost cap of $0.05; raise it with /dream settings')
  })
})

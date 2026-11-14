// The apply of a staged plan (docs/specs/dreaming.md "Undo and staged plans"): the staged units of an auto run, the held plan that an
// auto run leaves for apply, the approved apply of a propose run, the status that finds the waiting plan, and apply itself. The
// setup is in service-test-kit.ts; service.test.ts holds the run modes, the cadence and the budget.
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { RECENT_TIER, stagedFileOf, writeMemoryFile } from './files.ts'
import type { JudgeResult } from './judge.ts'
import type { JudgeCandidate } from './prompt.ts'
import { DreamRefused } from './service.ts'
import { keepJudge, PERSON, serviceKit } from './service-test-kit.ts'

const kit = serviceKit()

describe('auto staged units (audit finding)', () => {
  test('a chat write during the judge turn stages the unit, and the staged base is the pre-judge one: apply refuses', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers'])
    const svc = kit.service({
      judge: async (personId, candidates) => {
        // the person's chat write lands while the judge reads: the file is no longer the one the judge saw
        writeMemoryFile(kit.dataDir, PERSON, RECENT_TIER, '- Typed during the judge\n')
        return keepJudge(personId, candidates)
      },
    })
    const result = await svc.run(PERSON, 'schedule')
    expect(result.status).toBe('applied')
    expect(result.staged).toBe(true)
    expect(kit.recent()).toBe('- Typed during the judge\n')
    let thrown: unknown
    try {
      await svc.apply(PERSON, result.runId ?? '')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DreamRefused)
    expect((thrown as DreamRefused).reason).toBe('staged-changed')
    expect(kit.recent()).toBe('- Typed during the judge\n')
  })
})

/** The texts the profile tests judge into profile.md; every other message is kept as a short-term fact of recent.md. */
const PROFILE_TEXT: Record<string, string> = {
  'Remember this: I like tea': 'Likes tea',
  'Please remember I have a cat': 'Has a cat',
}
const profileJudge = async (
  _personId: string,
  candidates: readonly JudgeCandidate[],
): Promise<JudgeResult> => ({
  ok: true,
  plan: {
    candidates: candidates.map((c) => {
      const profileText = PROFILE_TEXT[c.text]
      return profileText === undefined
        ? {
            id: c.id,
            action: 'keep-short-term' as const,
            target: 'recent',
            text: c.text,
            reason: 'said today',
            importance: 3,
            sourceMessageId: c.messageId,
          }
        : {
            id: c.id,
            action: 'promote' as const,
            target: 'profile',
            text: profileText,
            reason: 'asked to remember',
            importance: 3,
            sourceMessageId: c.messageId,
          }
    }),
  },
})

describe('auto: a held plan after the run wrote recent.md (fix: staged-changed false positive)', () => {
  test('an auto run that writes recent.md and holds a profile proposal: apply writes profile.md, no staged-changed', async () => {
    kit.repo.setMode(PERSON, 'auto', PERSON)
    kit.plant(['I like short answers', 'Remember this: I like tea', 'Please remember I have a cat'])
    const svc = kit.service({ judge: profileJudge })
    const run = await svc.run(PERSON, 'schedule')
    expect(run.status).toBe('applied')
    expect(run.staged).toBe(true)
    expect(kit.recent()).toContain('- I like short answers')
    expect(kit.profile()).toBeUndefined()

    const applied = await svc.apply(PERSON, run.runId ?? '')
    expect(applied.applied).toBe(2)
    expect(kit.profile()).toContain('Likes tea')
    expect(kit.profile()).toContain('Has a cat')
    expect(existsSync(stagedFileOf(kit.dataDir, PERSON, run.runId ?? ''))).toBe(false)
  })
})

describe('approved apply of a held plan (fix: global rules staged the approved plan again)', () => {
  test('a propose run with two profile promotions stages them; apply writes profile.md with both', async () => {
    kit.repo.setMode(PERSON, 'propose', PERSON)
    kit.plant(['Remember this: I like tea', 'Please remember I have a cat'])
    const svc = kit.service({ judge: profileJudge })
    const run = await svc.run(PERSON, 'schedule')
    expect(run.staged).toBe(true)
    expect(kit.profile()).toBeUndefined()

    const applied = await svc.apply(PERSON, run.runId ?? '')
    expect(applied.applied).toBe(2)
    expect(applied.staged).toBe(0)
    expect(kit.profile()).toContain('Likes tea')
    expect(kit.profile()).toContain('Has a cat')
    expect(existsSync(stagedFileOf(kit.dataDir, PERSON, run.runId ?? ''))).toBe(false)
  })

  test('a plan over the run cap (41 candidates) staged in propose is written in full by apply', async () => {
    kit.repo.setMode(PERSON, 'propose', PERSON)
    kit.plant(Array.from({ length: 41 }, (_, i) => `Fact number ${i + 1}`))
    const svc = kit.service()
    const run = await svc.run(PERSON, 'schedule')
    expect(run.counts.candidates).toBe(41)
    const applied = await svc.apply(PERSON, run.runId ?? '')
    expect(applied.applied).toBe(41)
    expect(kit.recent()).toContain('- Fact number 41\n')
  })
})

describe('status finds the waiting plan (fix: a later run hid it)', () => {
  test('a skipped run after a staged run: canApply is true and stagedRunId names the staged run', async () => {
    kit.repo.setMode(PERSON, 'propose', PERSON)
    kit.plant(['I like short answers'])
    const svc = kit.service()
    const staged = await svc.run(PERSON, 'schedule')
    await svc.skip(PERSON, 'schedule', 'few-messages')

    const status = await svc.status(PERSON)
    expect(status.lastRun?.status).toBe('skipped')
    expect(status.lastRun?.staged).toBe(false)
    expect(status.canApply).toBe(true)
    expect(status.stagedRunId).toBe(staged.runId ?? undefined)
    // the start of the staged run (its diary day), not the skipped run's
    expect(status.stagedRunStartedAt).toBe(
      kit.repo.listRuns(PERSON, 50).find((r) => r.id === staged.runId)?.startedAt,
    )
    expect(status.stagedExpiresAt).toBeDefined()

    await svc.apply(PERSON, status.stagedRunId ?? '')
    expect(kit.recent()).toContain('- I like short answers')
    const after = await svc.status(PERSON)
    expect(after.canApply).toBe(false)
    expect(after.stagedRunId).toBeUndefined()
  })
})

describe('apply', () => {
  test('apply on a file changed since the judge refuses with staged-changed and writes nothing', async () => {
    kit.repo.setMode(PERSON, 'propose', PERSON)
    kit.plant(['I like short answers'])
    const result = await kit.service().run(PERSON, 'schedule')
    writeMemoryFile(kit.dataDir, PERSON, RECENT_TIER, '- Typed by the person\n')
    let thrown: unknown
    try {
      await kit.service().apply(PERSON, result.runId ?? '')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DreamRefused)
    expect((thrown as DreamRefused).reason).toBe('staged-changed')
    expect(kit.recent()).toBe('- Typed by the person\n')
    // the outdated plan is dropped: no staged file, the row says why, and the cursor did not move
    expect(existsSync(stagedFileOf(kit.dataDir, PERSON, result.runId ?? ''))).toBe(false)
    expect(kit.repo.listRuns(PERSON)[0]).toMatchObject({
      status: 'rejected',
      reason: 'staged-changed',
    })
    expect(kit.repo.cursorOf(PERSON)).toBeUndefined()
    expect(await kit.service().status(PERSON)).toMatchObject({ canApply: false })
  })

  test('apply writes the staged plan, sets the undo window, and a second apply is a no-op', async () => {
    kit.repo.setMode(PERSON, 'propose', PERSON)
    kit.plant(['I like short answers'])
    const svc = kit.service()
    const run = await svc.run(PERSON, 'schedule')
    const first = await svc.apply(PERSON, run.runId ?? '')
    expect(first.applied).toBe(1)
    expect(kit.recent()).toContain('- I like short answers')
    expect(existsSync(stagedFileOf(kit.dataDir, PERSON, run.runId ?? ''))).toBe(false)
    const before = kit.recent()
    const second = await svc.apply(PERSON, run.runId ?? '')
    expect(second.applied).toBe(0)
    expect(kit.recent()).toBe(before)
    expect(kit.audits.filter((a) => a.kind === 'dream.apply')).toHaveLength(1)
    expect(kit.repo.listRuns(PERSON)[0]?.undoUntil).not.toBeNull()
  })

  test('undo removes the file that the staged apply created', async () => {
    kit.repo.setMode(PERSON, 'propose', PERSON)
    kit.plant(['I like short answers'])
    const svc = kit.service()
    const run = await svc.run(PERSON, 'schedule')
    await svc.apply(PERSON, run.runId ?? '')
    const restored = svc.undo(PERSON, run.runId ?? '')
    expect(restored.restored).toBe(0)
    expect(kit.recent()).toBeUndefined()
    expect(() => svc.undo(PERSON)).toThrow(DreamRefused)
  })
})

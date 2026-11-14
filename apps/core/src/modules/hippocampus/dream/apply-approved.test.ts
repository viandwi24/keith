// The applier when the person approved a staged plan (`approved`, docs/specs/dreaming.md Rule 4 and "Applier"), and the run caps
// that stage a plan in full. Split from apply.test.ts (file size); the shared helpers are in apply-test-kit.ts.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DreamPlan } from '@keith/contracts'
import { type ApplyResult, applyPlan } from './apply.ts'
import { applyIn, cand, filesOf, PERSON, plan, RUN, TODAY } from './apply-test-kit.ts'
import { ARCHIVE_TIER, PROFILE_TIER, RECENT_TIER, writeMemoryFile } from './files.ts'
import { memoryBaseOf } from './staged.ts'
import type { DreamCandidate } from './types.ts'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-dream-approved-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function applyTo(p: DreamPlan, candidates: DreamCandidate[], dryRun = false): ApplyResult {
  return applyIn(dataDir, p, candidates, { dryRun })
}

const recent = () => filesOf(dataDir).recent()
const profile = () => filesOf(dataDir).profile()
const topic = (name: string) => filesOf(dataDir).topic(name)

describe('approved apply (the person approved the staged plan)', () => {
  const profileTwo = () =>
    plan(
      { id: 'c1', action: 'promote', target: 'profile', text: 'Likes tea' },
      { id: 'c2', action: 'promote', target: 'profile', text: 'Has a cat' },
    )
  const profileCands = () => [
    cand('c1', 'Remember this: I like tea'),
    cand('c2', 'Please remember I have a cat'),
  ]

  test('the same two profile promotions stage when judged, and are written when approved', () => {
    const staged = applyTo(profileTwo(), profileCands())
    expect(staged.staged.map((s) => s.reason)).toEqual(['profile-proposal', 'profile-proposal'])
    expect(profile()).toBeUndefined()

    const base = memoryBaseOf(dataDir, PERSON, [PROFILE_TIER, RECENT_TIER, ARCHIVE_TIER])
    const approved = applyPlan({
      dataDir,
      personId: PERSON,
      runId: RUN,
      today: TODAY,
      plan: profileTwo(),
      candidates: profileCands(),
      base,
      approved: true,
    })
    expect(approved.staged).toEqual([])
    expect(approved.written.map((w) => w.id)).toEqual(['c1', 'c2'])
    expect(profile()).toContain('Likes tea')
    expect(profile()).toContain('Has a cat')
  })

  test('a plan over the run cap (41 candidates) is written in full when approved', () => {
    const ids = Array.from({ length: 41 }, (_, i) => `c${i + 1}`)
    const items = ids.map((id) => ({
      id,
      action: 'keep-short-term' as const,
      target: 'recent',
      text: `Fact ${id}`,
    }))
    const candidates = ids.map((id) => cand(id, `Fact ${id} said`))
    expect(applyTo(plan(...items), candidates).staged).toHaveLength(41)

    const base = memoryBaseOf(dataDir, PERSON, [PROFILE_TIER, RECENT_TIER, ARCHIVE_TIER])
    const approved = applyPlan({
      dataDir,
      personId: PERSON,
      runId: RUN,
      today: TODAY,
      plan: plan(...items),
      candidates,
      base,
      approved: true,
    })
    expect(approved.staged).toEqual([])
    expect(approved.written).toHaveLength(41)
    expect(recent()).toContain('- Fact c41\n')
  })

  test('an approved plan keeps the per-unit guards: a file changed since the base stages its unit', () => {
    const base = memoryBaseOf(dataDir, PERSON, [PROFILE_TIER, RECENT_TIER, ARCHIVE_TIER])
    writeMemoryFile(dataDir, PERSON, RECENT_TIER, '- Typed after the judge\n')
    const approved = applyPlan({
      dataDir,
      personId: PERSON,
      runId: RUN,
      today: TODAY,
      plan: plan({ id: 'c1', action: 'keep-short-term', target: 'recent', text: 'Likes tea' }),
      candidates: [cand('c1', 'I like tea')],
      base,
      approved: true,
    })
    expect(approved.written).toEqual([])
    expect(approved.staged).toEqual([{ id: 'c1', reason: 'staged-changed' }])
    expect(recent()).toBe('- Typed after the judge\n')
  })
})

describe('caps (40 candidates, 10 files: staged in full)', () => {
  test('41 candidates are all staged with reason cap', () => {
    const ids = Array.from({ length: 41 }, (_, i) => `c${i + 1}`)
    const result = applyTo(
      plan(
        ...ids.map((id) => ({
          id,
          action: 'keep-short-term' as const,
          target: 'recent',
          text: `Fact ${id}`,
        })),
      ),
      ids.map((id) => cand(id, `Fact ${id} said`)),
    )
    expect(result.written).toEqual([])
    expect(result.staged).toHaveLength(41)
    expect(result.staged.every((s) => s.reason === 'cap')).toBe(true)
    expect(recent()).toBeUndefined()
  })

  test('a plan that would change 11 files is staged in full', () => {
    const items = Array.from({ length: 11 }, (_, i) => ({
      id: `c${i + 1}`,
      action: 'promote' as const,
      target: `topic-${i + 1}.md`,
      text: `Fact ${i + 1}`,
    }))
    const result = applyTo(
      plan(...items),
      items.map((item, i) => cand(item.id, `Remember this: fact ${i + 1}`)),
    )
    expect(result.written).toEqual([])
    expect(result.staged.map((s) => s.reason)).toEqual(Array(11).fill('cap'))
    expect(topic('topic-1.md')).toBeUndefined()
  })
})

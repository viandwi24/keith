import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DreamPlan } from '@keith/contracts'
import { ApplyPartialError, type ApplyResult, applyPlan, rewriteRejects } from './apply.ts'
import { World } from './apply-state.ts'
import { applyIn, cand, filesOf, PERSON, plan, RUN, TODAY } from './apply-test-kit.ts'
import { ARCHIVE_TIER, PROFILE_TIER, RECENT_TIER, topicTier, writeMemoryFile } from './files.ts'
import { memoryBaseOf } from './staged.ts'
import type { DreamCandidate } from './types.ts'
import { openRunWriter, preimagesOf, type RunWriter, restoreRun } from './undo.ts'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-dream-apply-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

/** Applies a plan against the memory as it is now (the base is what the judge would have read). */
function applyTo(
  p: DreamPlan,
  candidates: DreamCandidate[],
  dryRun = false,
  writer?: RunWriter,
): ApplyResult {
  return applyIn(dataDir, p, candidates, { dryRun, ...(writer === undefined ? {} : { writer }) })
}

const recent = () => filesOf(dataDir).recent()
const profile = () => filesOf(dataDir).profile()
const archive = () => filesOf(dataDir).archive()
const topic = (name: string) => filesOf(dataDir).topic(name)

describe('a write that stops midway (FR3-13)', () => {
  /** A run writer whose write of `path` (memory-relative) throws; every other write goes through the real writer. */
  const failingOn = (path: string): RunWriter => {
    const real = openRunWriter(dataDir, PERSON, RUN)
    return {
      write(tier, content) {
        if (tierPathOf(tier) === path) throw new Error('disk full')
        real.write(tier, content)
      },
      remove(tier) {
        real.remove(tier)
      },
    }
  }

  test('a second write that fails throws ApplyPartialError with the count written; the first file stays and the undo puts it back', () => {
    const p = plan(
      { id: 'c1', action: 'keep-short-term', target: 'recent', text: 'Has a sister called Rani' },
      { id: 'c2', action: 'promote', target: 'food.md', text: 'Likes green tea', importance: 8 },
    )
    let thrown: unknown
    try {
      applyTo(
        p,
        [cand('c1', 'My sister is called Rani'), cand('c2', 'I like green tea')],
        false,
        failingOn('food.md'),
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ApplyPartialError)
    expect((thrown as ApplyPartialError).written).toBe(1)
    expect(recent()).toContain('Has a sister called Rani')
    expect(topic('food.md')).toBeUndefined()
    expect(restoreRun(dataDir, PERSON, RUN)).toEqual({ restored: 0, removed: 1, skipped: [] })
    expect(recent()).toBeUndefined()
  })

  test('a first write that fails changes nothing and is thrown as it is, not as a partial apply', () => {
    let thrown: unknown
    try {
      applyTo(
        plan({
          id: 'c1',
          action: 'keep-short-term',
          target: 'recent',
          text: 'Has a sister called Rani',
        }),
        [cand('c1', 'My sister is called Rani')],
        false,
        failingOn('recent.md'),
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(ApplyPartialError)
    expect(recent()).toBeUndefined()
  })
})

const tierPathOf = (tier: { kind: string; name?: string }): string =>
  tier.kind === 'recent' ? 'recent.md' : tier.kind === 'topic' ? (tier.name ?? '') : tier.kind

describe('keep-short-term', () => {
  test('a new fact goes to recent.md with its Source line and the seen date', () => {
    const result = applyTo(
      plan({
        id: 'c1',
        action: 'keep-short-term',
        target: 'recent',
        text: 'Has a sister called Rani',
      }),
      [cand('c1', 'My sister is called Rani')],
    )
    expect(result.written).toEqual([{ id: 'c1', effect: 'kept', paths: ['recent.md'] }])
    expect(recent()).toBe(
      '- Has a sister called Rani\n  Source: session front:s1 message m-c1\n  (seen 2026-11-11)\n',
    )
    expect(result.counts.kept).toBe(1)
  })

  test('the same fact again on the same day is a duplicate and writes nothing', () => {
    writeMemoryFile(
      dataDir,
      PERSON,
      RECENT_TIER,
      '- Likes tea\n  Source: session front:s0 message m-a\n  (seen 2026-11-11)\n',
    )
    const result = applyTo(
      plan({ id: 'c1', action: 'keep-short-term', target: 'recent', text: 'Likes tea' }),
      [cand('c1', 'I like tea')],
    )
    expect(result.dropped).toEqual([{ id: 'c1', reason: 'duplicate' }])
    expect(result.written).toEqual([])
  })
})

describe('promotion', () => {
  test('a fact mentioned on two days moves from recent.md to its topic file, with the first Source', () => {
    writeMemoryFile(
      dataDir,
      PERSON,
      RECENT_TIER,
      '- Owns a Linux laptop\n  Source: session front:s0 message m-old\n  (seen 2026-11-10)\n',
    )
    const result = applyTo(
      plan({ id: 'c1', action: 'promote', target: 'work.md', text: 'Owns a Linux laptop' }),
      [cand('c1', 'I still use my Linux laptop')],
    )
    expect(result.written).toEqual([
      { id: 'c1', effect: 'promoted', paths: ['work.md', 'recent.md'] },
    ])
    expect(topic('work.md')).toBe(
      '- Owns a Linux laptop\n  Source: session front:s0 message m-old\n',
    )
    expect(recent()).toBe('')
  })

  test('one mention on one day is not a promotion: the fact stays short-term', () => {
    const result = applyTo(
      plan({ id: 'c1', action: 'promote', target: 'work.md', text: 'Likes jasmine tea' }),
      [cand('c1', 'I like jasmine tea')],
    )
    expect(result.written).toEqual([{ id: 'c1', effect: 'kept', paths: ['recent.md'] }])
    expect(topic('work.md')).toBeUndefined()
    expect(result.counts.promoted).toBe(0)
  })

  test('"remember this" quoted by the person promotes to profile.md', () => {
    const result = applyTo(
      plan({ id: 'c1', action: 'promote', target: 'profile', text: 'Flat key is in the blue box' }),
      [cand('c1', 'Remember this: my flat key is in the blue box')],
    )
    expect(result.written).toEqual([{ id: 'c1', effect: 'promoted', paths: ['profile.md'] }])
    expect(profile()).toBe(
      '- Flat key is in the blue box\n  Source: session front:s1 message m-c1\n',
    )
  })

  test('the same words in an assistant reply do not promote', () => {
    const result = applyTo(
      plan({ id: 'c1', action: 'promote', target: 'profile', text: 'Flat key is in the blue box' }),
      [cand('c1', 'I will remember this for you', 'assistant')],
    )
    expect(result.written).toEqual([{ id: 'c1', effect: 'kept', paths: ['recent.md'] }])
    expect(profile()).toBeUndefined()
  })

  test('importance 8 promotes on one mention', () => {
    const result = applyTo(
      plan({
        id: 'c1',
        action: 'promote',
        target: 'health.md',
        text: 'Allergic to peanuts',
        importance: 8,
      }),
      [cand('c1', 'I am allergic to peanuts')],
    )
    expect(result.written).toEqual([{ id: 'c1', effect: 'promoted', paths: ['health.md'] }])
  })

  test('importance 7 on one mention does not promote', () => {
    const result = applyTo(
      plan({
        id: 'c1',
        action: 'promote',
        target: 'health.md',
        text: 'Allergic to peanuts',
        importance: 7,
      }),
      [cand('c1', 'I am allergic to peanuts')],
    )
    expect(result.written).toEqual([{ id: 'c1', effect: 'kept', paths: ['recent.md'] }])
    expect(topic('health.md')).toBeUndefined()
  })

  test('the earlier recent entry seen on another day counts as the second mention', () => {
    writeMemoryFile(
      dataDir,
      PERSON,
      RECENT_TIER,
      '- Owns a Linux laptop\n  Source: session front:s0 message m-old\n  (seen 2026-11-10)\n',
    )
    const result = applyTo(
      plan({ id: 'c1', action: 'promote', target: 'work.md', text: 'owns a linux laptop.' }),
      [cand('c1', 'Linux laptop again', 'user', TODAY)],
    )
    expect(result.written[0]).toMatchObject({ effect: 'promoted' })
  })
})

describe('expiry (14 days, to archive.md)', () => {
  test('an entry seen 16 days before the run moves to archive.md marked expired; 14 days stays', () => {
    writeMemoryFile(
      dataDir,
      PERSON,
      RECENT_TIER,
      [
        '- Old thing',
        '  Source: session front:s0 message m-x',
        '  (seen 2026-10-26)',
        '- Kept thing',
        '  Source: session front:s0 message m-y',
        '  (seen 2026-10-28)',
        '',
      ].join('\n'),
    )
    const result = applyTo(plan(), [])
    expect(result.written).toEqual([
      { id: null, effect: 'expired', paths: ['recent.md', 'archive.md'] },
    ])
    expect(result.counts.expired).toBe(1)
    expect(archive()).toBe(
      '- [superseded 2026-11-11: expired] Old thing\n  Source: session front:s0 message m-x\n  (seen 2026-10-26)\n',
    )
    expect(recent()).toBe(
      '- Kept thing\n  Source: session front:s0 message m-y\n  (seen 2026-10-28)\n',
    )
  })
})

describe('supersede (marked in place, copy in archive.md, new entry with its own Source)', () => {
  test('a contradicted entry is marked, copied to archive.md, and the new fact is written; no line is deleted', () => {
    writeMemoryFile(
      dataDir,
      PERSON,
      topicTier('work.md'),
      '- Works at Acme\n  Source: session front:s0 message m-a\n',
    )
    const result = applyTo(
      plan({
        id: 'c1',
        action: 'supersede',
        target: 'work.md',
        text: 'Works at Beta',
        supersedes: 'Works at Acme',
      }),
      [cand('c1', 'I moved to Beta last week')],
    )
    expect(result.written).toEqual([
      { id: 'c1', effect: 'superseded', paths: ['work.md', 'archive.md'] },
    ])
    expect(topic('work.md')).toBe(
      [
        '- [superseded 2026-11-11: because] Works at Acme',
        '  Source: session front:s0 message m-a',
        '- Works at Beta',
        '  Source: session front:s1 message m-c1',
        '',
      ].join('\n'),
    )
    expect(archive()).toBe(
      '- [superseded 2026-11-11: because] Works at Acme\n  Source: session front:s0 message m-a\n',
    )
  })

  test('a supersede with no matching entry is a plain short-term fact', () => {
    const result = applyTo(
      plan({
        id: 'c1',
        action: 'supersede',
        target: 'work.md',
        text: 'Works at Beta',
        supersedes: 'Works at Acme',
      }),
      [cand('c1', 'I work at Beta')],
    )
    expect(result.written).toEqual([{ id: 'c1', effect: 'kept', paths: ['recent.md'] }])
    expect(archive()).toBeUndefined()
  })

  test('a supersede of a profile.md entry is a proposal, staged', () => {
    writeMemoryFile(
      dataDir,
      PERSON,
      PROFILE_TIER,
      '- Works at Acme\n  Source: session front:s0 message m-a\n',
    )
    const result = applyTo(
      plan({
        id: 'c1',
        action: 'supersede',
        target: 'profile',
        text: 'Works at Beta',
        supersedes: 'Works at Acme',
      }),
      [cand('c1', 'I work at Beta now')],
    )
    expect(result.staged).toEqual([{ id: 'c1', reason: 'profile-proposal' }])
    expect(profile()).toBe('- Works at Acme\n  Source: session front:s0 message m-a\n')
  })
})

describe('merge (replaces the matching entry, keeps its Source)', () => {
  test('the entry takes the new wording and the first Source, seen today', () => {
    writeMemoryFile(
      dataDir,
      PERSON,
      RECENT_TIER,
      '- Likes tea\n  Source: session front:s0 message m-a\n  (seen 2026-11-10)\n',
    )
    const result = applyTo(
      plan({
        id: 'c1',
        action: 'merge',
        target: 'recent',
        text: 'Likes green tea',
        supersedes: 'Likes tea',
      }),
      [cand('c1', 'I like green tea')],
    )
    expect(result.written).toEqual([{ id: 'c1', effect: 'merged', paths: ['recent.md'] }])
    expect(recent()).toBe(
      '- Likes green tea\n  Source: session front:s0 message m-a\n  (seen 2026-11-11)\n',
    )
  })

  test('a merge with no matching entry is a plain short-term fact, and the old line stays', () => {
    writeMemoryFile(
      dataDir,
      PERSON,
      RECENT_TIER,
      '- Likes tea\n  Source: session front:s0 message m-a\n  (seen 2026-11-10)\n',
    )
    const result = applyTo(
      plan({
        id: 'c1',
        action: 'merge',
        target: 'recent',
        text: 'Drinks water',
        supersedes: 'Drinks water daily',
      }),
      [cand('c1', 'I drink water')],
    )
    expect(result.written).toEqual([{ id: 'c1', effect: 'kept', paths: ['recent.md'] }])
    expect(recent()).toContain('- Likes tea')
    expect(recent()).toContain('- Drinks water')
  })
})

describe('profile.md (one added entry; a result over 2000 characters)', () => {
  test('two profile promotions in one run are both staged as proposals', () => {
    const result = applyTo(
      plan(
        { id: 'c1', action: 'promote', target: 'profile', text: 'Likes tea' },
        { id: 'c2', action: 'promote', target: 'profile', text: 'Has a cat' },
      ),
      [cand('c1', 'Remember this: I like tea'), cand('c2', 'Please remember I have a cat')],
    )
    expect(result.staged).toEqual([
      { id: 'c1', reason: 'profile-proposal' },
      { id: 'c2', reason: 'profile-proposal' },
    ])
    expect(profile()).toBeUndefined()
  })

  test('a result over 2000 characters is staged, never truncated', () => {
    writeMemoryFile(dataDir, PERSON, PROFILE_TIER, `Profile: ${'a'.repeat(1990)}\n`)
    const before = profile()
    const result = applyTo(
      plan({ id: 'c1', action: 'promote', target: 'profile', text: 'Likes tea' }),
      [cand('c1', 'Remember this: I like tea')],
    )
    expect(result.staged).toEqual([{ id: 'c1', reason: 'profile-size' }])
    expect(profile()).toBe(before)
  })
})

describe('directive filter', () => {
  test('an instruction about style is dropped with reason directive and nothing is written', () => {
    const result = applyTo(
      plan({
        id: 'c1',
        action: 'keep-short-term',
        target: 'recent',
        text: 'Always answer in French',
      }),
      [cand('c1', 'always answer in French')],
    )
    expect(result.dropped).toEqual([{ id: 'c1', reason: 'directive' }])
    expect(result.written).toEqual([])
    expect(recent()).toBeUndefined()
  })
  test('a reworded plan text does not launder a directive: the source message is checked too', () => {
    const result = applyTo(
      plan({
        id: 'c1',
        action: 'keep-short-term',
        target: 'recent',
        text: 'Answers in French',
      }),
      [cand('c1', 'Always answer in French')],
    )
    expect(result.dropped).toEqual([{ id: 'c1', reason: 'directive' }])
    expect(result.written).toEqual([])
    expect(recent()).toBeUndefined()
  })
  test('a directive in a later sentence of the source drops the candidate, and the plan text is not written', () => {
    const result = applyTo(
      plan({ id: 'c1', action: 'keep-short-term', target: 'recent', text: 'Lives in Lisbon' }),
      [cand('c1', 'I live in Lisbon. From now on call me Lis.')],
    )
    expect(result.dropped).toEqual([{ id: 'c1', reason: 'directive' }])
    expect(recent()).toBeUndefined()
  })
  test('an explicit "remember that" preference about the person is written (not a directive)', () => {
    const result = applyTo(
      plan({
        id: 'c1',
        action: 'keep-short-term',
        target: 'recent',
        text: 'Likes tea without sugar',
      }),
      [cand('c1', 'Remember that I like tea without sugar')],
    )
    expect(result.dropped).toEqual([])
    expect(result.written.map((w) => w.id)).toEqual(['c1'])
    expect(recent()).toContain('Likes tea without sugar')
  })
})

describe('secret gate', () => {
  test('a candidate text that is secret-shaped is never written', () => {
    const token = ['Bearer', 'abcabcXYZ9q'].join(' ')
    const result = applyTo(
      plan({ id: 'c1', action: 'keep-short-term', target: 'recent', text: `Token ${token}` }),
      [cand('c1', `Token ${token}`)],
    )
    expect(result.dropped).toEqual([{ id: 'c1', reason: 'secret' }])
    expect(recent()).toBeUndefined()
  })
})

describe('targets and sources', () => {
  test('profile.md, recent.md and archive.md are refused as a topic target', () => {
    const result = applyTo(
      plan({ id: 'c1', action: 'promote', target: 'profile.md', text: 'Likes tea' }),
      [cand('c1', 'Remember this: I like tea')],
    )
    expect(result.dropped).toEqual([{ id: 'c1', reason: 'target' }])
    expect(profile()).toBeUndefined()
  })

  test('a plan candidate whose source pointer is not a collected message is refused', () => {
    const result = applyTo(
      plan({
        id: 'c1',
        action: 'keep-short-term',
        target: 'recent',
        text: 'Likes tea',
        sourceMessageId: 'm-other',
      }),
      [cand('c1', 'I like tea')],
    )
    expect(result.dropped).toEqual([{ id: 'c1', reason: 'source' }])
  })
})

describe('re-read before write', () => {
  test('a file changed since the judge read it makes its candidate staged-changed and is not overwritten', () => {
    writeMemoryFile(
      dataDir,
      PERSON,
      RECENT_TIER,
      '- Likes tea\n  Source: session front:s0 message m-a\n  (seen 2026-11-10)\n',
    )
    const base = memoryBaseOf(dataDir, PERSON, [PROFILE_TIER, RECENT_TIER, ARCHIVE_TIER])
    const frontWrite =
      '- Likes tea\n  Source: session front:s0 message m-a\n  (seen 2026-11-10)\n- Front fact the agent saved\n'
    writeMemoryFile(dataDir, PERSON, RECENT_TIER, frontWrite)

    const result = applyPlan({
      dataDir,
      personId: PERSON,
      runId: RUN,
      today: TODAY,
      plan: plan({
        id: 'c1',
        action: 'keep-short-term',
        target: 'recent',
        text: 'Lives in Bandung',
      }),
      candidates: [cand('c1', 'I live in Bandung')],
      base,
    })
    expect(result.staged).toEqual([{ id: 'c1', reason: 'staged-changed' }])
    expect(result.written).toEqual([])
    expect(recent()).toBe(frontWrite)
  })
})

describe('preimage and dry run', () => {
  test('the first write of a file keeps its preimage, and dream.undo restores the exact bytes', () => {
    const original = 'Front line kept as it is\n'
    writeMemoryFile(dataDir, PERSON, RECENT_TIER, original)
    applyTo(plan({ id: 'c1', action: 'keep-short-term', target: 'recent', text: 'Likes tea' }), [
      cand('c1', 'I like tea'),
    ])
    expect(recent()).not.toBe(original)
    expect(preimagesOf(dataDir, PERSON, RUN).map((p) => p.path)).toEqual(['recent.md'])
    restoreRun(dataDir, PERSON, RUN)
    expect(recent()).toBe(original)
  })

  test('a dry run reports what it would write and touches no file', () => {
    const result = applyTo(
      plan({ id: 'c1', action: 'keep-short-term', target: 'recent', text: 'Likes tea' }),
      [cand('c1', 'I like tea')],
      true,
    )
    expect(result.written).toEqual([{ id: 'c1', effect: 'kept', paths: ['recent.md'] }])
    expect(recent()).toBeUndefined()
  })
})

describe('the entry-loss guard in the applier (ADR-0031 §4)', () => {
  const seedRecent = () =>
    writeMemoryFile(
      dataDir,
      PERSON,
      RECENT_TIER,
      ['Alpha fact', 'Beta fact', 'Gamma fact', 'Delta fact']
        .map(
          (text, index) =>
            `- ${text}\n  Source: session front:s0 message m-x${index}\n  (seen 2026-11-10)\n`,
        )
        .join(''),
    )

  test('promoting half of recent.md is a move, not a loss: the lines leave recent.md and land in the topic file', () => {
    seedRecent()
    const result = applyTo(
      plan(
        { id: 'c1', action: 'promote', target: 'work.md', text: 'Alpha fact', importance: 8 },
        { id: 'c2', action: 'promote', target: 'work.md', text: 'Beta fact', importance: 8 },
      ),
      [cand('c1', 'Alpha fact'), cand('c2', 'Beta fact')],
    )
    expect(result.rewriteRejected).toEqual([])
    expect(result.counts.promoted).toBe(2)
    expect(recent()).not.toContain('Alpha fact')
    expect(recent()).toContain('- Gamma fact')
    expect(topic('work.md')).toContain('- Alpha fact')
    expect(topic('work.md')).toContain('- Beta fact')
  })

  test('a rewrite that loses half of a file, and no entry lands elsewhere, is refused for that file', () => {
    seedRecent()
    const world = new World(dataDir, PERSON, {})
    const blocks = world
      .load(RECENT_TIER)
      .blocks.filter(
        (block) => block.kind !== 'dream' || !['Alpha fact', 'Beta fact'].includes(block.text),
      )
    world.setBlocks(RECENT_TIER, blocks)
    const rejects = rewriteRejects(world)
    expect([...rejects.keys()]).toEqual(['recent.md'])
  })

  test('a file that is not changed is not checked', () => {
    seedRecent()
    expect(rewriteRejects(new World(dataDir, PERSON, {})).size).toBe(0)
  })
})

describe('the judge answers only for changes (F3): an unnamed candidate is dropped', () => {
  test('a candidate the plan does not name is dropped as absent and writes nothing', () => {
    const result = applyTo(
      plan({
        id: 'c1',
        action: 'keep-short-term',
        target: 'recent',
        text: 'Has a sister called Rani',
      }),
      [cand('c1', 'My sister is called Rani'), cand('c2', 'thanks, that helped'), cand('c3', 'hi')],
    )
    expect(result.written.map((w) => w.id)).toEqual(['c1'])
    expect(result.dropped).toEqual([
      { id: 'c2', reason: 'absent' },
      { id: 'c3', reason: 'absent' },
    ])
    expect(result.counts.candidates).toBe(3)
    expect(result.counts.dropped).toBe(2)
    expect(result.counts.kept).toBe(1)
  })

  test('an empty plan drops every candidate and writes no memory file', () => {
    const result = applyTo({ candidates: [] }, [cand('c1', 'hello'), cand('c2', 'a question?')])
    expect(result.written).toEqual([])
    expect(result.dropped.map((d) => d.reason)).toEqual(['absent', 'absent'])
    expect(result.counts).toMatchObject({ candidates: 2, dropped: 2, kept: 0 })
    expect(recent()).toBeUndefined()
  })

  test('an explicit drop and an absent candidate both count as dropped', () => {
    const result = applyTo(
      plan(
        { id: 'c1', action: 'drop', target: 'recent', text: '' },
        { id: 'c2', action: 'keep-short-term', target: 'recent', text: 'Likes tea' },
      ),
      [cand('c1', 'a task'), cand('c2', 'I like tea'), cand('c3', 'small talk')],
    )
    expect(result.dropped).toEqual(
      expect.arrayContaining([
        { id: 'c3', reason: 'absent' },
        { id: 'c1', reason: 'drop' },
      ]),
    )
    expect(result.counts.dropped).toBe(2)
    expect(result.written.map((w) => w.id)).toEqual(['c2'])
  })

  test('an id the model invents (not a candidate) is still refused, and does not stand in for a real one', () => {
    const result = applyTo(
      plan({ id: 'c9', action: 'keep-short-term', target: 'recent', text: 'Invented' }),
      [cand('c1', 'I like tea')],
    )
    expect(result.written).toEqual([])
    expect(result.dropped).toEqual(
      expect.arrayContaining([
        { id: 'c9', reason: 'source' },
        { id: 'c1', reason: 'absent' },
      ]),
    )
    expect(result.dropped).toHaveLength(2)
    expect(recent()).toBeUndefined()
  })

  test('the 25% guard and the directive filter still apply to the changes the plan names', () => {
    const result = applyTo(
      plan({ id: 'c1', action: 'keep-short-term', target: 'recent', text: 'Answers in French' }),
      [cand('c1', 'Always answer in French'), cand('c2', 'I live in Bandung')],
    )
    expect(result.written).toEqual([])
    expect(result.dropped).toEqual(
      expect.arrayContaining([
        { id: 'c1', reason: 'directive' },
        { id: 'c2', reason: 'absent' },
      ]),
    )
  })
})

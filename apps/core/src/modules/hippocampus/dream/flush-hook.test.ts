import { describe, expect, test } from 'bun:test'
import type { DreamingSettings, DreamMode } from '@keith/contracts'
import type { DreamingRepo } from '@keith/db'
import { MEMORY_FLUSH_TOOLS } from 'eharness/memory'
import { resolvePlugin } from 'eharness/testing'
import { dayOf } from './collect.ts'
import {
  dreamFlushHook,
  dreamFlushLine,
  dreamFlushPlugin,
  MANUAL_FLUSH_LINE,
  manualFlushPatch,
  mergeFlushPatches,
} from './flush-hook.ts'

const OWNER = 'owner'
const ANA = 'ana-person'
const BEN = 'ben-person'
const FIXED_NOW = new Date(2026, 10, 11, 9, 30).getTime()

/** A repo that holds the stored modes and records every person it is asked about. */
function fakeRepo(modes: Record<string, DreamMode>) {
  const asked: string[] = []
  const repo: Pick<DreamingRepo, 'getMode'> = {
    getMode(personId) {
      asked.push(personId)
      return modes[personId]
    },
  }
  return { repo, asked }
}

function hookWith(
  modes: Record<string, DreamMode>,
  memberDefault: DreamingSettings['memberDefault'] = 'off',
) {
  const { repo, asked } = fakeRepo(modes)
  const hook = dreamFlushHook({
    repo,
    owner: { isOwner: async (personId) => personId === OWNER },
    settings: () => ({ memberDefault }),
    now: () => FIXED_NOW,
  })
  return { hook, asked }
}

describe('dreamFlushHook (ADR-0031 §9)', () => {
  test('mode off: no flush patch, so the merged flush request has no added line', async () => {
    const { hook } = hookWith({ [ANA]: 'off' })
    expect(await hook({ principal: { id: ANA } })).toBeUndefined()
  })

  test('mode propose: the flush prompt carries the recent.md line with the date', async () => {
    const { hook } = hookWith({ [ANA]: 'propose' })
    const patch = await hook({ principal: { id: ANA } })
    expect(patch?.flush.prompt).toBe(dreamFlushLine(dayOf(FIXED_NOW)))
    expect(patch?.flush.prompt).toContain('recent.md')
    expect(patch?.flush.prompt).toContain(dayOf(FIXED_NOW))
    expect(patch?.flush.tools).toEqual([...MEMORY_FLUSH_TOOLS])
  })

  test('mode auto: the line is added too', async () => {
    const { hook } = hookWith({ [ANA]: 'auto' })
    expect((await hook({ principal: { id: ANA } }))?.flush.prompt).toContain('recent.md')
  })

  test('the dreaming line is the same for a manual and a turn compaction (the abort policy is separate)', async () => {
    const { hook } = hookWith({ [ANA]: 'propose' })
    const turn = await hook({ principal: { id: ANA } })
    const manual = await hook({ principal: { id: ANA } })
    expect(manual).toEqual(turn)
    expect(manual?.flush).not.toHaveProperty('onFailure')
    expect(manual?.flush.prompt).toBe(dreamFlushLine(dayOf(FIXED_NOW)))
  })

  test('no other person mode is read: only the session principal is asked', async () => {
    const { hook, asked } = hookWith({ [ANA]: 'off', [BEN]: 'propose' })
    await hook({ principal: { id: ANA } })
    expect(asked).toEqual([ANA])
  })

  test('a member with no stored mode gets the member default (off by default, no line)', async () => {
    const { hook } = hookWith({})
    expect(await hook({ principal: { id: ANA } })).toBeUndefined()
  })

  test('the owner with no stored mode is propose by default: the line is added', async () => {
    const { hook } = hookWith({})
    expect((await hook({ principal: { id: OWNER } }))?.flush.prompt).toContain('recent.md')
  })

  test('no principal: nothing is added and no mode is read', async () => {
    const { hook, asked } = hookWith({ [ANA]: 'propose' })
    expect(await hook({})).toBeUndefined()
    expect(asked).toEqual([])
  })
})

describe('manualFlushPatch (eharness 0.13.0, spec 06 §5.2a rule 9a)', () => {
  test('a manual compaction (/new, /compact) asks to abort when the flush fails or is skipped', () => {
    expect(manualFlushPatch({ trigger: 'manual' })).toEqual({
      flush: { prompt: MANUAL_FLUSH_LINE, onFailure: 'abort' },
    })
  })

  test('automatic compactions (turn, auto, overflow) get no patch: the default continue stays', () => {
    expect(manualFlushPatch({ trigger: 'turn' })).toBeUndefined()
    expect(manualFlushPatch({ trigger: 'auto' })).toBeUndefined()
    expect(manualFlushPatch({ trigger: 'overflow' })).toBeUndefined()
    expect(manualFlushPatch({})).toBeUndefined()
  })
})

describe('mergeFlushPatches', () => {
  test('the dreaming line and the manual abort merge into one patch with abort', () => {
    const merged = mergeFlushPatches(
      { flush: { prompt: 'DREAM', tools: ['memory_create'] } },
      manualFlushPatch({ trigger: 'manual' }),
    )
    expect(merged).toEqual({
      flush: {
        prompt: `DREAM\n\n${MANUAL_FLUSH_LINE}`,
        tools: ['memory_create'],
        onFailure: 'abort',
      },
    })
  })

  test('one side alone is returned as it is; none gives none', () => {
    const dream = { flush: { prompt: 'DREAM', tools: ['memory_create'] } }
    expect(mergeFlushPatches(dream, undefined)).toBe(dream)
    expect(mergeFlushPatches(undefined, undefined)).toBeUndefined()
  })
})

describe('dreamFlushPlugin hook', () => {
  // the plugin's `compaction.before` hook, resolved by `resolvePlugin`; the principal is the context override
  const resolveFlush = (options: Parameters<typeof dreamFlushPlugin>[0]) =>
    resolvePlugin(dreamFlushPlugin(options))
  const repo = {
    getMode: (id: string) => ({ [ANA]: 'off' as const, [BEN]: 'propose' as const })[id],
  }
  const owner = { isOwner: async () => false }
  const settings = () => ({ memberDefault: 'off' as const })

  test('mode off and a manual compaction: only the abort part', async () => {
    const flush = await resolveFlush({ repo, owner, settings, now: () => FIXED_NOW })
    expect(
      await flush.runHook('compaction.before', { trigger: 'manual', messages: [], tokens: 0 }, {
        principal: { id: ANA },
      } as never),
    ).toEqual({
      flush: { prompt: MANUAL_FLUSH_LINE, onFailure: 'abort' },
    })
  })

  test('mode off and a turn compaction: no patch at all', async () => {
    const flush = await resolveFlush({ repo, owner, settings, now: () => FIXED_NOW })
    expect(
      await flush.runHook('compaction.before', { trigger: 'turn', messages: [], tokens: 0 }, {
        principal: { id: ANA },
      } as never),
    ).toBeUndefined()
  })

  test('mode propose and a turn compaction: the dreaming line, no abort', async () => {
    const flush = await resolveFlush({ repo, owner, settings, now: () => FIXED_NOW })
    const patch = (await flush.runHook(
      'compaction.before',
      { trigger: 'turn', messages: [], tokens: 0 },
      {
        principal: { id: BEN },
      } as never,
    )) as {
      flush: { onFailure?: string; prompt: string }
    }
    expect(patch.flush.prompt).toContain('recent.md')
    expect(patch.flush.onFailure).toBeUndefined()
  })
})

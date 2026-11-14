// An idle core costs one due check per tick (docs/specs/hypothalamus.md, "Tick"; the owner's laptop overheats): with no
// enabled protocol the trigger pass reads nothing, writes no cursor and no schedule, and the engine tick is one `claimDue`.
import { describe, expect, test } from 'bun:test'
import { memoryScheduleStore, type ScheduleStore } from 'eharness/scheduler'
import { APPROVAL_PING_BEFORE_MS } from './builtins.ts'
import { createProtocolCatalog } from './catalog.ts'
import { createRunStarter } from './engine.ts'
import { harness, NOW } from './engine-harness.ts'
import { type CursorStore, createTriggers, type TriggerCursor } from './triggers.ts'

/** A store whose every call is counted by name: the fake that proves what an idle tick touches. */
function counting() {
  const calls: string[] = []
  const hit = (name: string): void => {
    calls.push(name)
  }
  const schedules = memoryScheduleStore()
  const counted: ScheduleStore = {
    get(id) {
      hit('schedules.get')
      return schedules.get(id)
    },
    list(query) {
      hit('schedules.list')
      return schedules.list(query)
    },
    put(schedule) {
      hit('schedules.put')
      return schedules.put(schedule)
    },
    delete(id) {
      hit('schedules.delete')
      return schedules.delete(id)
    },
    due(now, limit) {
      hit('schedules.due')
      return schedules.due(now, limit)
    },
    claim(id, version, owner, leaseUntil) {
      hit('schedules.claim')
      return schedules.claim(id, version, owner, leaseUntil)
    },
    complete(id, owner, advance) {
      hit('schedules.complete')
      return schedules.complete(id, owner, advance)
    },
    release(id, owner) {
      hit('schedules.release')
      return schedules.release(id, owner)
    },
  }
  let cursor: TriggerCursor | undefined
  const cursorStore: CursorStore = {
    get() {
      hit('cursor.get')
      return cursor
    },
    set(next) {
      hit('cursor.set')
      cursor = next
    },
  }
  return {
    calls,
    counted,
    cursorStore,
    feed: {
      async read() {
        calls.push('feed.read')
        return []
      },
      async lastSeq() {
        calls.push('feed.lastSeq')
        return 0
      },
      async prunedThrough() {
        calls.push('feed.prunedThrough')
        return 0
      },
    },
    signals: {
      async since() {
        calls.push('signals.since')
        return []
      },
    },
    lastSign: {
      async lastSign() {
        calls.push('lastSign')
        return null
      },
    },
  }
}

describe('an idle tick', () => {
  test('with no enabled protocol the trigger pass reads and writes nothing', async () => {
    const fake = counting()
    const h = harness()
    const protocols = {
      list: (owner?: string) => {
        fake.calls.push('protocols.list')
        return h.protocols.list(owner)
      },
      version: h.protocols.version,
    }
    const triggers = createTriggers({
      pingBeforeMs: () => APPROVAL_PING_BEFORE_MS,
      runs: createRunStarter(h.engine),
      protocols: createProtocolCatalog({ protocols, warn: () => {} }),
      feed: fake.feed,
      signals: fake.signals,
      lastSign: fake.lastSign,
      schedules: fake.counted,
      cursor: fake.cursorStore,
      now: () => NOW,
    })
    // the first tick of a store initialises the cursor and loads the (empty) protocol set once
    await triggers.tick()
    expect(fake.calls).toEqual(
      expect.arrayContaining(['feed.lastSeq', 'cursor.get', 'cursor.set', 'protocols.list']),
    )
    fake.calls.length = 0
    for (let i = 0; i < 5; i++) await triggers.tick()
    expect(fake.calls).toEqual([])
  })

  test('an idle beat (triggers, then the engine) is exactly one claimDue query', async () => {
    const h = harness()
    const fake = counting()
    let claims = 0
    const realClaim = h.runs.claimDue
    h.runs.claimDue = (...args: Parameters<typeof realClaim>) => {
      claims++
      return realClaim(...args)
    }
    const triggers = createTriggers({
      pingBeforeMs: () => APPROVAL_PING_BEFORE_MS,
      runs: createRunStarter(h.engine),
      protocols: createProtocolCatalog({ protocols: h.protocols, warn: () => {} }),
      feed: fake.feed,
      signals: fake.signals,
      lastSign: fake.lastSign,
      schedules: fake.counted,
      cursor: fake.cursorStore,
      now: () => NOW,
    })
    await triggers.tick()
    fake.calls.length = 0
    claims = 0
    for (let i = 0; i < 3; i++) {
      await triggers.tick()
      const outcome = await h.engine.tick()
      expect(outcome).toEqual({ claimed: 0, cancelled: 0, skipped: false })
    }
    expect(claims).toBe(3)
    expect(fake.calls).toEqual([])
  })

  test('with a listener and no new feed row the tick is one head read and writes no cursor', async () => {
    const fake = counting()
    const triggers = createTriggers({
      pingBeforeMs: () => APPROVAL_PING_BEFORE_MS,
      runs: { start: async () => 'refused' },
      protocols: {
        async active() {
          return [
            {
              id: 'p1',
              version: 1,
              owner: 'ana',
              savedAt: 0,
              trigger: { kind: 'event', type: 'delivery.failed' },
            },
          ]
        },
      },
      feed: fake.feed,
      signals: fake.signals,
      lastSign: fake.lastSign,
      schedules: fake.counted,
      cursor: fake.cursorStore,
      now: () => NOW,
    })
    await triggers.tick()
    fake.calls.length = 0
    for (let i = 0; i < 3; i++) await triggers.tick()
    expect(fake.calls).toEqual(['feed.lastSeq', 'feed.lastSeq', 'feed.lastSeq'])
  })
})

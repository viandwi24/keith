import { describe, expect, test } from 'bun:test'
import type { Viewer } from '@keith/host/views'
import type { ActivityInput, ActivityStore } from 'eharness/activity'
import { inMemoryActivityStore } from 'eharness/activity'
import { viewKeith } from './compose-views.ts'
import { createViewEvents } from './view-events.ts'

const ana: Viewer = { principalId: 'ana', method: 'password' }
const rhea: Viewer = { principalId: 'rhea', method: 'password' }
const EVERYONE = '*'

/** A plugin record as the plugin feed writes it: one record per recipient, `to` the person (or `*`). */
const event = (plugin: string, name: string, to: string, data: unknown): ActivityInput => ({
  type: `plugin.${plugin}.${name}`,
  sessionId: null,
  agentId: null,
  payload: { plugin, event: name, to, data },
})

/** Lets the poller run a few cycles (the interval is 5 ms in these tests). */
const settle = (ms = 60) => Bun.sleep(ms)

/** A store that counts reads, so a test can see whether the poller still runs. */
function countingStore(inner: ActivityStore) {
  const counts = { reads: 0 }
  const store: ActivityStore = {
    append: (e) => inner.append(e),
    read: (q) => {
      counts.reads++
      return inner.read(q)
    },
    lastSeq: () => inner.lastSeq(),
    prunedThrough: () => inner.prunedThrough(),
    prune: (o) => inner.prune(o),
  }
  return { store, counts }
}

describe('view events: the feed-backed port', () => {
  test('a view gets the events of its plugin addressed to its person, and the public ones', async () => {
    const store = inMemoryActivityStore()
    const events = createViewEvents({ store, intervalMs: 5 })
    const got: Array<{ who: string; data: unknown }> = []
    const offAna = events.subscribe(ana, 'notes', 'note.created', (d) =>
      got.push({ who: 'ana', data: d }),
    )
    const offRhea = events.subscribe(rhea, 'notes', 'note.created', (d) =>
      got.push({ who: 'rhea', data: d }),
    )
    await store.append([
      event('notes', 'note.created', 'ana', { id: 1 }),
      event('notes', 'note.created', 'rhea', { id: 2 }),
      event('notes', 'note.created', EVERYONE, { id: 3 }),
    ])
    await settle()
    // one record at a time, in seq order: each record reaches its own recipients
    expect(got).toEqual([
      { who: 'ana', data: { id: 1 } },
      { who: 'rhea', data: { id: 2 } },
      { who: 'ana', data: { id: 3 } },
      { who: 'rhea', data: { id: 3 } },
    ])
    offAna()
    offRhea()
  })

  test('filtered by plugin and by event name: another plugin or event is not delivered', async () => {
    const store = inMemoryActivityStore()
    const events = createViewEvents({ store, intervalMs: 5 })
    const got: unknown[] = []
    const off = events.subscribe(ana, 'notes', 'note.created', (d) => got.push(d))
    await store.append([
      event('reminders', 'note.created', 'ana', 'other plugin'),
      event('notes', 'note.deleted', 'ana', 'other event'),
      event('notes', 'note.created', 'ana', 'mine'),
    ])
    await settle()
    expect(got).toEqual(['mine'])
    off()
  })

  test('no history: a listener starts at the head of the log, not at its start', async () => {
    const store = inMemoryActivityStore()
    await store.append([event('notes', 'note.created', 'ana', 'old')])
    const events = createViewEvents({ store, intervalMs: 5 })
    const got: unknown[] = []
    const off = events.subscribe(ana, 'notes', 'note.created', (d) => got.push(d))
    await settle()
    expect(got).toEqual([])
    await store.append([event('notes', 'note.created', 'ana', 'new')])
    await settle()
    expect(got).toEqual(['new'])
    off()
  })

  test('unsubscribe stops delivery, and the poller stops with the last listener', async () => {
    const { store, counts } = countingStore(inMemoryActivityStore())
    const events = createViewEvents({ store, intervalMs: 5 })
    const got: unknown[] = []
    const offA = events.subscribe(ana, 'notes', 'note.created', (d) => got.push(d))
    const offB = events.subscribe(ana, 'notes', 'note.created', () => {})
    await settle()
    offA()
    await store.append([event('notes', 'note.created', 'ana', 'after the unsubscribe')])
    await settle()
    expect(got).toEqual([])
    expect(events.listeners()).toBe(1)
    offB()
    expect(events.listeners()).toBe(0)
    await settle(20)
    const reads = counts.reads
    await settle(60)
    expect(counts.reads).toBe(reads)
    // a second unsubscribe is harmless
    offB()
    expect(events.listeners()).toBe(0)
  })

  test('a resync (prune past the cursor): pruned records are not replayed, survivors and new records arrive', async () => {
    const inner = inMemoryActivityStore()
    const events = createViewEvents({ store: inner, intervalMs: 5 })
    const got: unknown[] = []
    const off = events.subscribe(ana, 'notes', 'note.created', (d) => got.push(d))
    await settle()
    await inner.append([
      event('notes', 'note.created', 'ana', 'a'),
      event('notes', 'note.created', 'ana', 'b'),
    ])
    await settle()
    expect(got).toEqual(['a', 'b'])
    // no poll between these two calls: `c` is pruned before the poller reads it, `d` survives the prune
    await inner.append([
      event('notes', 'note.created', 'ana', 'c'),
      event('notes', 'note.created', 'ana', 'd'),
    ])
    await inner.prune({ keepLast: 1 })
    await settle()
    expect(got).toEqual(['a', 'b', 'd'])
    await inner.append([event('notes', 'note.created', 'ana', 'e')])
    await settle()
    expect(got).toEqual(['a', 'b', 'd', 'e'])
    off()
  })

  test('a resync tells the listeners of the view once; an ordinary read does not', async () => {
    const inner = inMemoryActivityStore()
    const events = createViewEvents({ store: inner, intervalMs: 5 })
    let resyncs = 0
    const got: unknown[] = []
    const off = events.subscribe(ana, 'notes', 'note.created', (d) => got.push(d), {
      onResync: () => resyncs++,
    })
    const quiet = events.subscribe(rhea, 'notes', 'note.created', () => {})
    await settle()
    await inner.append([event('notes', 'note.created', 'ana', 'a')])
    await settle()
    expect(got).toEqual(['a'])
    expect(resyncs).toBe(0)
    // records pruned before the poller reads them: the listener is told once, the survivor still arrives
    await inner.append([
      event('notes', 'note.created', 'ana', 'b'),
      event('notes', 'note.created', 'ana', 'c'),
    ])
    await inner.prune({ keepLast: 1 })
    await settle()
    expect(resyncs).toBe(1)
    expect(got).toEqual(['a', 'c'])
    await inner.append([event('notes', 'note.created', 'ana', 'd')])
    await settle()
    expect(resyncs).toBe(1)
    off()
    quiet()
  })

  test('a listener without onResync and a throwing onResync do not stop the others', async () => {
    const inner = inMemoryActivityStore()
    const warnings: string[] = []
    const events = createViewEvents({ store: inner, intervalMs: 5, warn: (m) => warnings.push(m) })
    let heard = 0
    const offThrows = events.subscribe(ana, 'notes', 'note.created', () => {}, {
      onResync: () => {
        throw new Error('boom')
      },
    })
    const offPlain = events.subscribe(ana, 'notes', 'note.created', () => {
      heard++
    })
    await settle()
    await inner.append([
      event('notes', 'note.created', 'ana', 'x'),
      event('notes', 'note.created', 'ana', 'y'),
    ])
    await inner.prune({ keepLast: 1 })
    await settle()
    expect(heard).toBe(1)
    expect(warnings.some((w) => w.includes('a resync handler of notes threw'))).toBe(true)
    offThrows()
    offPlain()
  })

  test('the view keith passes onResync through to the port', async () => {
    const inner = inMemoryActivityStore()
    const events = createViewEvents({ store: inner, intervalMs: 5 })
    const make = (_v: Viewer, _id: string, _signal: AbortSignal) => ({
      viewId: 'notes.list',
      call: async () => undefined as never,
      events: (
        target: string,
        handler: (d: unknown) => void,
        options?: { onResync?: () => void },
      ) =>
        events.subscribe(
          ana,
          target.slice(0, target.indexOf('.')),
          target.slice(target.indexOf('.') + 1),
          handler,
          options,
        ),
    })
    const keith = viewKeith(make as never)(ana, 'notes.list', new AbortController().signal)
    let resyncs = 0
    const off = keith.events('notes.note.created', () => {}, { onResync: () => resyncs++ })
    await settle()
    await inner.append([
      event('notes', 'note.created', 'ana', 'x'),
      event('notes', 'note.created', 'ana', 'y'),
    ])
    await inner.prune({ keepLast: 1 })
    await settle()
    expect(resyncs).toBe(1)
    off()
  })

  test('a throwing handler is reported and does not stop the others', async () => {
    const store = inMemoryActivityStore()
    const warned: string[] = []
    const events = createViewEvents({ store, intervalMs: 5, warn: (m) => warned.push(m) })
    const got: unknown[] = []
    const offBad = events.subscribe(ana, 'notes', 'note.created', () => {
      throw new Error('boom')
    })
    const offGood = events.subscribe(ana, 'notes', 'note.created', (d) => got.push(d))
    await store.append([event('notes', 'note.created', 'ana', 'x')])
    await settle()
    expect(got).toEqual(['x'])
    expect(warned.length).toBeGreaterThan(0)
    offBad()
    offGood()
  })

  test('the view keith: events of another plugin are a no-op, and a closed view removes its listener', async () => {
    const store = inMemoryActivityStore()
    const events = createViewEvents({ store, intervalMs: 5 })
    const ctrl = new AbortController()
    const seen: unknown[] = []
    const make = (_v: Viewer, _id: string, _signal: AbortSignal) => ({
      viewId: 'notes.list',
      call: async () => undefined as never,
      events: (target: string, handler: (d: unknown) => void) => {
        return events.subscribe(
          ana,
          target.slice(0, target.indexOf('.')),
          target.slice(target.indexOf('.') + 1),
          handler,
        )
      },
    })
    const keith = viewKeith(make as never)(ana, 'notes.list', ctrl.signal)
    const offOther = keith.events('reminders.reminder.fired', () => seen.push('other'))
    const offOwn = keith.events('notes.note.created', (d) => seen.push(d))
    expect(events.listeners()).toBe(1)
    await store.append([
      event('reminders', 'reminder.fired', 'ana', 'x'),
      event('notes', 'note.created', 'ana', 'own'),
    ])
    await settle()
    expect(seen).toEqual(['own'])
    // the view closes: its listener is removed without the view unsubscribing itself
    ctrl.abort()
    expect(events.listeners()).toBe(0)
    offOther()
    offOwn()
  })
})

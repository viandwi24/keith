import { describe, expect, test } from 'bun:test'
import type { ThreadId } from '../../shared/types.ts'
import {
  HAPPY,
  HAPPY_MAIN,
  MISSION,
  PARTY,
  PEPPER,
  PEPPER_MAIN,
  TONY,
  TONY_MAIN,
} from '../testing/fixture.ts'
import { createReflectionHarness, jsonTurn, type ReflectionHarness } from '../testing/reflect.ts'
import type { Reflector } from '../types.ts'
import { createReflectionJob, REFLECT_PER_TICK } from './job.ts'

const MINUTE = 60_000

/** A reflector whose passes stay open until released (or aborted). */
function controllableReflector() {
  const calls: { threadId: ThreadId; signal: AbortSignal }[] = []
  const releases: (() => void)[] = []
  const reflector: Reflector = {
    reflect(a) {
      calls.push(a)
      return new Promise((resolve) => {
        const done = () => resolve(null)
        releases.push(done)
        a.signal.addEventListener('abort', done, { once: true })
      })
    },
  }
  const releaseAll = () => {
    for (const release of releases.splice(0)) release()
  }
  return { reflector, calls, releaseAll }
}

function jobFor(h: ReflectionHarness, reflector: Reflector) {
  return createReflectionJob({ ...h.deps, reflector })
}

/** Emits a tick and waits for its handler (listing and starting passes) to finish. */
async function tick(h: ReflectionHarness): Promise<void> {
  h.events.emit('scheduler.ticked', { at: h.clock.now() })
  await h.events.idle()
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('reflection job', () => {
  test('a thread idle for less than idleMinutes is not reflected; after idleMinutes it is, in the background lane', async () => {
    const h = await createReflectionHarness()
    const r = controllableReflector()
    const job = jobFor(h, r.reflector)
    job.start()
    await h.say(TONY_MAIN, TONY, 'hello')

    h.clock.advance(20 * MINUTE - 1)
    await tick(h)
    expect(r.calls).toHaveLength(0)

    h.clock.advance(1)
    await tick(h)
    expect(r.calls.map((c) => c.threadId)).toEqual([TONY_MAIN])
    expect(h.scheduler.lanes).toEqual(['background'])
    r.releaseAll()
    await job.stop()
  })

  test('two ticks during one pass start one pass; a later tick may start the next', async () => {
    const h = await createReflectionHarness()
    const r = controllableReflector()
    const job = jobFor(h, r.reflector)
    job.start()
    await h.say(TONY_MAIN, TONY, 'hello')
    h.clock.advance(21 * MINUTE)

    await tick(h)
    await tick(h)
    expect(r.calls).toHaveLength(1)

    r.releaseAll()
    await flush()
    await tick(h)
    expect(r.calls).toHaveLength(2)
    r.releaseAll()
    await job.stop()
  })

  test(`one tick starts at most ${REFLECT_PER_TICK} passes, oldest idle first`, async () => {
    const h = await createReflectionHarness()
    const r = controllableReflector()
    const job = jobFor(h, r.reflector)
    job.start()
    for (const [thread, person] of [
      [TONY_MAIN, TONY],
      [PEPPER_MAIN, PEPPER],
      [HAPPY_MAIN, HAPPY],
      [MISSION, TONY],
      [PARTY, HAPPY],
    ] as const) {
      await h.say(thread, person, 'hi')
      h.clock.advance(1)
    }
    h.clock.advance(30 * MINUTE)
    await tick(h)
    expect(r.calls.map((c) => c.threadId)).toEqual([TONY_MAIN, PEPPER_MAIN, HAPPY_MAIN, MISSION])
    // Those passes finish (moving their cursors); the next tick picks up the rest.
    for (const c of r.calls) await h.threads.setReflectedThrough(c.threadId, 1)
    r.releaseAll()
    await flush()
    await tick(h)
    expect(r.calls.at(-1)?.threadId).toBe(PARTY)
    r.releaseAll()
    await job.stop()
  })

  test('enabled = false does nothing', async () => {
    const h = await createReflectionHarness({ reflect: { enabled: false } })
    const r = controllableReflector()
    const job = jobFor(h, r.reflector)
    job.start()
    await h.say(TONY_MAIN, TONY, 'hello')
    h.clock.advance(60 * MINUTE)
    await tick(h)
    expect(r.calls).toHaveLength(0)
    await job.stop()
  })

  test('stop() aborts a running pass, waits for it, and unsubscribes', async () => {
    const h = await createReflectionHarness()
    const r = controllableReflector()
    const job = jobFor(h, r.reflector)
    job.start()
    job.start() // idempotent: one subscription
    await h.say(TONY_MAIN, TONY, 'hello')
    h.clock.advance(21 * MINUTE)
    await tick(h)
    expect(r.calls).toHaveLength(1)

    await job.stop()
    expect(r.calls[0]?.signal.aborted).toBe(true)
    await tick(h)
    expect(r.calls).toHaveLength(1)
  })

  test('a failing tick or pass is logged and does not stop the job', async () => {
    const h = await createReflectionHarness()
    let fail = true
    const reflector: Reflector = {
      async reflect() {
        throw new Error('boom')
      },
    }
    const listForReflection = h.threads.listForReflection.bind(h.threads)
    h.threads.listForReflection = async (q) => {
      if (fail) throw new Error('db down')
      return listForReflection(q)
    }
    const job = jobFor(h, reflector)
    job.start()
    await h.say(TONY_MAIN, TONY, 'hello')
    h.clock.advance(21 * MINUTE)
    await tick(h)
    fail = false
    await tick(h)
    await flush()
    const warnings = h.log.entries.filter((e) => e.level === 'warn').map((e) => e.msg)
    expect(warnings).toContain('reflection tick failed')
    expect(warnings).toContain('reflection pass failed')
    await job.stop()
  })

  test('with the real reflector, an idle thread becomes memories on a tick', async () => {
    const h = await createReflectionHarness({
      script: [jsonTurn({ facts: [{ content: "Tony's sister is called Maria.", about: TONY }], notes: [] })],
    })
    h.reflection.job.start()
    await h.say(TONY_MAIN, TONY, 'My sister is Maria.')
    h.clock.advance(20 * MINUTE)
    await tick(h)
    for (let i = 0; i < 50 && !h.events.emitted.some((e) => e.name === 'memory.reflected'); i++) await flush()
    expect([...h.memories.rows.values()].map((m) => m.content)).toEqual(["Tony's sister is called Maria."])
    expect((await h.threads.get(TONY_MAIN))?.reflectedThroughSeq).toBe(1)
    await h.reflection.job.stop()
  })
})

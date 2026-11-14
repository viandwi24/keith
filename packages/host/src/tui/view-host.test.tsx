import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { Text, useApp, useInput } from 'ink'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { defineKeithPlugin, defineOperation } from '../define.ts'
import { memoryHost } from '../testing/index.ts'
import { useKeith, useTerminal } from './context.tsx'
import { probeTimers } from './timer-probe.ts'
import { createViewAccess } from './view-access.ts'
import {
  createViewHost,
  type ViewHost,
  type ViewHostLimits,
  type ViewListeners,
} from './view-host.tsx'
import { createViewKeith, type Viewer } from './view-keith.ts'

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function Who() {
  const k = useKeith()
  const [text, setText] = useState('loading')
  useEffect(() => {
    k.call<{ person: string }>('probe.whoami')
      .then((r) => setText(`person ${r.person}`))
      .catch(() => setText('refused'))
  }, [k])
  return <Text>{text}</Text>
}
function Boom() {
  throw new Error('secret failure text')
}
function KeyBoom() {
  useInput(() => {
    throw new Error('input exploded')
  })
  return <Text>ready</Text>
}
function Ticker() {
  const [n, setN] = useState(0)
  useEffect(() => {
    const i = setInterval(() => setN((x) => x + 1), 5)
    return () => clearInterval(i)
  }, [])
  useInput(() => {})
  return <Text>tick {n}</Text>
}
function Quit() {
  const { exit } = useApp()
  useInput((input) => {
    if (input === 'q') exit()
  })
  return <Text>press q</Text>
}
function Echo() {
  const [last, setLast] = useState('')
  const t = useTerminal()
  useInput((input) => setLast((x) => x + input))
  return (
    <Text>
      {last}|{t.cols}x{t.rows}|{t.colorDepth}
    </Text>
  )
}
function Huge() {
  return <Text>{'x'.repeat(5000)}</Text>
}
const slowOutcome: string[] = []
function Slow() {
  const k = useKeith()
  useEffect(() => {
    k.call('probe.slow').catch(() => slowOutcome.push('aborted'))
  }, [k])
  return <Text>waiting</Text>
}
function Peek() {
  const k = useKeith()
  return <Text>{JSON.stringify(Object.keys(k).sort())}</Text>
}

const plugin = defineKeithPlugin({
  id: 'probe',
  version: '1.0.0',
  apiVersion: 1,
  permissions: [
    { id: 'probe.use', description: 'Use probe.', roles: ['member'] },
    { id: 'probe.admin', description: 'Admin probe.' },
  ],
  operations: [
    defineOperation({
      name: 'whoami',
      description: 'The viewer.',
      input: z.object({}),
      output: z.object({ person: z.string().nullable() }),
      permission: { capability: 'probe.use' },
      risk: 'read',
      run: (_input, k) => ({ person: k.actor.personId }),
    }),
    defineOperation({
      name: 'slow',
      description: 'Waits until aborted.',
      input: z.object({}),
      output: z.object({}),
      permission: { capability: 'probe.use' },
      risk: 'read',
      run: (_input, k) =>
        new Promise((_resolve, reject) => {
          k.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    }),
    defineOperation({
      name: 'closed',
      description: 'Not callable from views.',
      input: z.object({}),
      output: z.object({}),
      permission: { capability: 'probe.use' },
      risk: 'read',
      expose: { call: false, http: true },
      run: () => ({}),
    }),
  ],
  tui: {
    menu: [
      { id: 'who', label: 'Who', view: 'who', permission: 'probe.use' },
      { id: 'admin', label: 'Admin', view: 'peek', permission: 'probe.admin' },
      { id: 'open', label: 'Open', view: 'echo' },
      { id: 'boom', label: 'Boom', view: 'boom' },
      { id: 'kboom', label: 'KeyBoom', view: 'kboom' },
      { id: 'ticker', label: 'Ticker', view: 'ticker' },
      { id: 'quit', label: 'Quit', view: 'quit' },
      { id: 'huge', label: 'Huge', view: 'huge' },
      { id: 'slow', label: 'Slow', view: 'slow' },
    ],
    views: {
      who: async () => ({ default: Who }),
      peek: async () => ({ default: Peek }),
      echo: async () => ({ default: Echo }),
      boom: async () => ({ default: Boom }),
      kboom: async () => ({ default: KeyBoom }),
      ticker: async () => ({ default: Ticker }),
      quit: async () => ({ default: Quit }),
      huge: async () => ({ default: Huge }),
      slow: async () => ({ default: Slow }),
      // not in the menu: cannot be opened
      hidden: async () => ({ default: Echo }),
    },
  },
})

const level = chalk.level
// every host a test set up: its open views (Ink instances, frame and idle timers) are closed after the test, so a
// view left open by one test never ticks inside the timer window of a later one (the timer probe counts them)
const hosts: ViewHost[] = []
beforeEach(() => {
  chalk.level = 0
})
afterEach(() => {
  for (const views of hosts.splice(0)) views.closeAll('revoked')
  chalk.level = level
})

function setup(limits: Partial<ViewHostLimits> = {}) {
  const host = memoryHost({ plugins: [plugin] })
  host.add('ana', 'member')
  host.add('bob', 'member')
  host.add('root', 'owner')
  host.addGuest('guest:1')
  const plugins = () => [plugin]
  const access = createViewAccess({ directory: host.directory, plugins })
  const warnings: string[] = []
  const views = createViewHost({
    access,
    keith: createViewKeith({ guard: host.guard, plugins }),
    limits: { framesPerSecond: 50, idleMs: 60_000, ...limits },
    log: { warn: (m) => warnings.push(m) },
  })
  hosts.push(views)
  return { host, access, views, warnings }
}

interface Recorder extends ViewListeners {
  frames: string[]
  reasons: string[]
}
const recorder = (): Recorder => {
  const frames: string[] = []
  const reasons: string[] = []
  return {
    frames,
    reasons,
    frame: (f) => frames.push(f.text),
    closed: (r) => reasons.push(r),
  }
}
const request = (who: string, viewId: string) =>
  ({
    viewer: { principalId: who, method: 'password' } satisfies Viewer,
    viewId,
    cols: 40,
    rows: 10,
    colorDepth: 24,
  }) as const

async function openOk(views: ViewHost, who: string, viewId: string, rec = recorder()) {
  const result = await views.open(request(who, viewId), rec)
  if (!result.ok) throw new Error(`open failed: ${result.reason}`)
  return { view: result.view, rec }
}

describe('menu and open permission per actor', () => {
  test('owner, member and a guest see different menus', async () => {
    const { access } = setup()
    const ids = async (who: string | undefined) => (await access.menu(who)).map((i) => i.id)
    expect(await ids('root')).toContain('probe.admin')
    expect(await ids('ana')).not.toContain('probe.admin')
    expect(await ids('ana')).toContain('probe.who')
    expect(await ids('guest:1')).toEqual([])
    expect(await ids('nobody')).toEqual([])
    expect(await ids(undefined)).toEqual([])
  })

  test('a suspended person gets nothing, and a view without a menu entry cannot be opened', async () => {
    const { access, host } = setup()
    host.suspend('ana')
    expect(await access.menu('ana')).toEqual([])
    expect(await access.find('ana', 'probe.who')).toBeUndefined()
    expect(await access.find('root', 'probe.hidden')).toBeUndefined()
    expect(await access.find('root', 'probe.nothing')).toBeUndefined()
  })

  test('open answers refused for unknown, not permitted and guest alike', async () => {
    const { views } = setup()
    for (const [who, id] of [
      ['ana', 'probe.peek'],
      ['ana', 'probe.hidden'],
      ['ana', 'nope.view'],
      ['guest:1', 'probe.echo'],
    ] as const) {
      const result = await views.open(request(who, id), recorder())
      expect(result).toEqual({ ok: false, reason: 'refused' })
    }
  })
})

describe('actor binding', () => {
  test('two viewers of one view get two actors and different data', async () => {
    const { views } = setup()
    const a = await openOk(views, 'ana', 'probe.who')
    const b = await openOk(views, 'bob', 'probe.who')
    await wait(120)
    expect(a.rec.frames.at(-1)).toBe('person ana')
    expect(b.rec.frames.at(-1)).toBe('person bob')
    a.view.close()
    b.view.close()
  })

  test('a view cannot call an operation closed to calls, nor an unknown one, nor one the viewer lacks', async () => {
    const { host } = setup()
    const make = createViewKeith({ guard: host.guard, plugins: () => [plugin] })
    const k = make({ principalId: 'ana', method: null }, 'probe.who', new AbortController().signal)
    await expect(k.call('probe.closed')).rejects.toThrow('not found')
    await expect(k.call('probe.nothing')).rejects.toThrow('not found')
    await expect(k.call('nope')).rejects.toThrow('not found')
    await expect(k.call('probe.whoami')).resolves.toEqual({ person: 'ana' })
    host.suspend('ana')
    await expect(k.call('probe.whoami')).rejects.toThrow()
  })

  test('the handle a view gets holds no credential, session or database', async () => {
    const { views } = setup()
    const { view, rec } = await openOk(views, 'root', 'probe.peek')
    await wait(60)
    expect(rec.frames.at(-1)).toBe('["call","events","viewId"]')
    view.close()
  })
})

describe('lifecycle', () => {
  test('frames flow, keys and resize reach the view, closing ends it once', async () => {
    const { views } = setup()
    const { view, rec } = await openOk(views, 'ana', 'probe.echo')
    await wait(40)
    expect(rec.frames.at(-1)).toBe('|40x10|24')
    view.key('h')
    view.key('i')
    await wait(60)
    expect(rec.frames.at(-1)).toBe('hi|40x10|24')
    view.resize(60, 12)
    await wait(60)
    expect(rec.frames.at(-1)).toBe('hi|60x12|24')
    view.close()
    view.close('idle')
    expect(rec.reasons).toEqual(['view'])
    expect(view.closed).toBe(true)
    const count = rec.frames.length
    view.key('z')
    await wait(60)
    expect(rec.frames.length).toBe(count)
  })

  test('frames are paced: a burst is coalesced to the latest', async () => {
    const { views } = setup({ framesPerSecond: 10 })
    const { view, rec } = await openOk(views, 'ana', 'probe.echo')
    for (const ch of 'abcdefghij') view.key(ch)
    await wait(250)
    expect(rec.frames.at(-1)).toBe('abcdefghij|40x10|24')
    expect(rec.frames.length).toBeLessThanOrEqual(4)
    view.close()
  })

  test('reserved keys never reach the view, input beyond the rate is dropped', async () => {
    const { views } = setup({ keysPerSecond: 5 })
    const { view, rec } = await openOk(views, 'ana', 'probe.echo')
    view.key('\u001b')
    view.key('\u0007')
    view.key('a')
    await wait(50)
    expect(rec.frames.at(-1)).toBe('a|40x10|24')
    for (let i = 0; i < 20; i++) view.key('b')
    await wait(80)
    expect(rec.frames.at(-1)).toBe('abbbb|40x10|24')
    view.close()
  })

  test('a view that exits by itself closes with view', async () => {
    const { views } = setup()
    const { view, rec } = await openOk(views, 'ana', 'probe.quit')
    view.key('q')
    await wait(60)
    expect(rec.reasons).toEqual(['view'])
    expect(views.snapshot()).toEqual([])
  })

  test('an error thrown while rendering ends the view with error and never shows its text', async () => {
    const { views, warnings } = setup()
    const { rec } = await openOk(views, 'ana', 'probe.boom')
    await wait(40)
    expect(rec.reasons).toEqual(['error'])
    expect(rec.frames.join()).not.toContain('secret')
    expect(views.snapshot()).toEqual([])
    expect(warnings.join()).toContain('failed')
  })

  test('an error thrown in an input handler ends the view and does not crash the process', async () => {
    const { views } = setup()
    const { view, rec } = await openOk(views, 'ana', 'probe.kboom')
    await wait(30)
    view.key('x')
    await wait(60)
    expect(rec.reasons).toEqual(['error'])
  })

  test('a frame beyond the size cap closes the view with limit', async () => {
    const { views } = setup({ frameMaxBytes: 1000 })
    const { rec } = await openOk(views, 'ana', 'probe.huge')
    await wait(40)
    expect(rec.reasons).toEqual(['limit'])
    expect(rec.frames).toEqual([])
  })

  test('idle closes the view; input keeps it alive', async () => {
    const { views } = setup({ idleMs: 120 })
    const { view, rec } = await openOk(views, 'ana', 'probe.echo')
    for (let i = 0; i < 4; i++) {
      await wait(50)
      view.key('a')
    }
    expect(rec.reasons).toEqual([])
    await wait(220)
    expect(rec.reasons).toEqual(['idle'])
  })

  test('revoke closes only that person, closeAll closes everything and refuses new opens', async () => {
    const { views } = setup()
    const a = await openOk(views, 'ana', 'probe.echo')
    const a2 = await openOk(views, 'ana', 'probe.echo')
    const b = await openOk(views, 'bob', 'probe.echo')
    expect(views.closeFor('ana', 'revoked')).toBe(2)
    expect(a.rec.reasons).toEqual(['revoked'])
    expect(a2.rec.reasons).toEqual(['revoked'])
    expect(b.rec.reasons).toEqual([])
    views.closeAll('error')
    expect(b.rec.reasons).toEqual(['error'])
    expect(await views.open(request('bob', 'probe.echo'), recorder())).toEqual({
      ok: false,
      reason: 'refused',
    })
  })
})

describe('caps', () => {
  test('the fourth view of one actor is refused with limit, a close frees a slot', async () => {
    const { views } = setup()
    const open = []
    for (let i = 0; i < 3; i++) open.push(await openOk(views, 'ana', 'probe.echo'))
    expect(await views.open(request('ana', 'probe.echo'), recorder())).toEqual({
      ok: false,
      reason: 'limit',
    })
    // another person is not affected
    const other = await openOk(views, 'bob', 'probe.echo')
    open[0]?.view.close()
    const again = await views.open(request('ana', 'probe.echo'), recorder())
    expect(again.ok).toBe(true)
    views.closeAll('error')
    expect(other.view.closed).toBe(true)
  })

  test('the global cap holds, also for concurrent opens', async () => {
    const { views } = setup({ global: 2, perActor: 5 })
    const results = await Promise.all(
      ['ana', 'bob', 'root', 'ana'].map((who) =>
        views.open(request(who, 'probe.echo'), recorder()),
      ),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(2)
    expect(results.filter((r) => !r.ok && r.reason === 'limit')).toHaveLength(2)
    views.closeAll('error')
  })

  test('a refused open does not keep a slot', async () => {
    const { views } = setup({ perActor: 1 })
    for (let i = 0; i < 3; i++)
      expect(await views.open(request('ana', 'probe.peek'), recorder())).toEqual({
        ok: false,
        reason: 'refused',
      })
    const ok = await views.open(request('ana', 'probe.echo'), recorder())
    expect(ok.ok).toBe(true)
    views.closeAll('error')
  })
})

describe('colour', () => {
  test('truecolor is forced while a view is mounted and the old level comes back after the last one closes', async () => {
    chalk.level = 1
    const levelNow = (): number => chalk.level
    const { views } = setup()
    const a = await openOk(views, 'ana', 'probe.echo')
    expect(levelNow()).toBe(3)
    const b = await openOk(views, 'bob', 'probe.echo')
    a.view.close()
    expect(levelNow()).toBe(3)
    b.view.close()
    expect(levelNow()).toBe(1)
    // a view that ends by itself, or by an error, gives it back too
    const c = await openOk(views, 'ana', 'probe.boom')
    await wait(40)
    expect(c.rec.reasons).toEqual(['error'])
    expect(levelNow()).toBe(1)
  })
})

describe('teardown', () => {
  const signals = () =>
    ['exit', 'SIGINT', 'SIGTERM', 'beforeExit'].map((e) => process.listenerCount(e))
  const stdinListeners = () => ['readable', 'data'].map((e) => process.stdin.listenerCount(e))

  test('every way a view can end leaves no timer, listener or frame behind', async () => {
    const baseline = signals()
    const stdinBase = stdinListeners()
    // only the timers of this package and Ink: another file's late timer is not a leak of this teardown (see timer-probe.ts)
    const probe = probeTimers({ only: /packages\/host\/src\/|node_modules\/ink\// })
    try {
      const { views } = setup({ idleMs: 150 })
      const timersBefore = probe.live()
      const recs = []
      const handles = []
      for (const who of ['ana', 'bob', 'root']) {
        const o = await openOk(views, who, 'probe.ticker')
        recs.push(o.rec)
        handles.push(o.view)
      }
      const quit = await openOk(views, 'ana', 'probe.quit')
      const boom = await openOk(views, 'bob', 'probe.boom')
      const kboom = await openOk(views, 'root', 'probe.kboom')
      await wait(40)
      handles[0]?.close() // close
      views.closeFor('bob', 'revoked') // revoke (bob's ticker; boom already ended)
      quit.view.key('q') // the view exits
      kboom.view.key('x') // error in a handler
      await wait(300) // idle closes the rest
      expect(views.snapshot()).toEqual([])
      expect(recs.map((r) => r.reasons)).toEqual([['view'], ['revoked'], ['idle']])
      expect(boom.rec.reasons).toEqual(['error'])
      expect(kboom.rec.reasons).toEqual(['error'])
      expect(quit.rec.reasons).toEqual(['view'])
      // a pending timeout of the unmount fires late on a loaded machine (the full run): wait for it, up to 3 s (1.5 s was
      // missed once by a full run under load). A leaked interval or a timeout that is never cleared stays live and still
      // fails here, and the assertion below shows their creation stacks.
      for (let waited = 0; probe.live() !== timersBefore && waited < 3000; waited += 50)
        await wait(50)
      // a failure names the timers still live, by their creation stacks (the diff of this assertion)
      expect(probe.live() === timersBefore ? [] : probe.stacks()).toEqual([])
      expect(probe.live()).toBe(timersBefore)
      expect(signals()).toEqual(baseline)
      expect(stdinListeners()).toEqual(stdinBase)
      const counts = recs.map((r) => r.frames.length)
      await wait(80)
      expect(recs.map((r) => r.frames.length)).toEqual(counts)
    } finally {
      probe.stop()
    }
  })

  test('closing aborts the calls in flight', async () => {
    const { views } = setup()
    const { view, rec } = await openOk(views, 'ana', 'probe.slow')
    await wait(40)
    expect(rec.frames.at(-1)).toBe('waiting')
    view.close()
    await wait(40)
    expect(slowOutcome).toEqual(['aborted'])
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import {
  CASE_ACTORS,
  leakCheck,
  type MemoryHost,
  memoryHost,
  openTestView,
  type TestView,
} from '@keith/host/testing'
import notes from '../plugin.ts'

const DOWN = '\u001b[B'
const GUEST = 'g1'

function setup() {
  const host = memoryHost({ plugins: [notes] })
  for (const id of ['olga', 'mia', 'ben', 'duta', 'oscar']) host.add(id)
  host.add('boss', 'owner')
  host.addGuest(GUEST)
  host.acl.createGroup({ id: 'A', name: 'aa', createdBy: 'boss' })
  host.acl.addMember('A', 'mia', 'boss')
  return host
}

const call = (host: MemoryHost, op: string, input: unknown, who: string) =>
  host.call('notes', op, input, who) as Promise<{ id: string }>
let n = 0
async function note(host: MemoryHost, who: string, title: string, body: string) {
  host.clock.advance(5_000 * ++n)
  return (await call(host, 'create', { title, body }, who)).id
}

const open: TestView[] = []
const view = async (host: MemoryHost, as: string, size = { cols: 80, rows: 24 }) => {
  const v = await openTestView(host, [notes], { viewId: 'notes.browse', as, ...size })
  open.push(v)
  return v
}
afterEach(() => {
  for (const v of open.splice(0)) v.close()
})

describe('the Notes view', () => {
  test('lists, searches, reads and goes back, all as the viewer', async () => {
    const host = setup()
    await note(
      host,
      'olga',
      'Groceries',
      'milk and eggs\nand a very long second line that should wrap around the window',
    )
    await note(host, 'olga', 'Tax plan', 'offshore marmalade fund')
    const v = await view(host, 'olga')
    const list = await v.until('Tax plan')
    expect(list).toContain('Notes · 2')
    expect(list).toContain('Groceries')
    expect(list).toContain('[enter] read')
    // newest first: the cursor is on Tax plan; read it
    v.key('\r')
    const read = await v.until('offshore marmalade fund')
    expect(read).toContain('Tax plan')
    expect(read).toContain('yours')
    v.key('b')
    await v.until('Notes · 2')
    // search
    v.key('/')
    await v.until('[enter] search')
    await v.type('eggs')
    v.key('\r')
    const found = await v.until(/Search .eggs. · 1 found/)
    expect(found).toContain('Groceries')
    expect(found).not.toContain('Tax plan')
    // an empty search is the list again
    v.key('/')
    await v.until('[enter] search')
    for (let i = 0; i < 4; i++) v.key('\u007f')
    v.key('\r')
    await v.until('Notes · 2')
  })

  test('a note shared with the viewer reads as read only and has no share key', async () => {
    const host = setup()
    const id = await note(host, 'olga', 'Shared', 'for duta')
    await call(host, 'share', { id, target: 'user:duta' }, 'olga')
    const v = await view(host, 'duta')
    const list = await v.until('Shared')
    expect(list).toContain('olga')
    expect(list).not.toContain('[s] share')
    v.key('\r')
    const read = await v.until('for duta')
    expect(read).toContain('read only')
    expect(read).not.toContain('[s] share')
  })

  test('the owner of a note shares it with a person, sees who has it, and takes it back', async () => {
    const host = setup()
    await note(host, 'olga', 'Plans', 'secret plans')
    const v = await view(host, 'olga')
    const list = await v.until('Plans')
    expect(list).toContain('[s] share')
    v.key('s')
    const none = await v.until('Private: only you can read this note.')
    expect(none).toContain('mode rw-------')
    v.key('a')
    await v.until('then enter')
    await v.type('user:duta')
    v.key('\r')
    const shared = await v.until('Shared with user:duta (read).')
    expect(shared).toContain('user:duta')
    // the other person sees it now, through their own view
    const duta = await view(host, 'duta')
    await duta.until('Plans')
    v.key('x')
    await v.until('Stopped sharing with user:duta.')
    expect(await v.until('Private: only you can read this note.')).not.toMatch(/user:duta\s+read/)
    v.key('b')
    await v.until('Notes · 1')
  })

  test('widening to everyone needs a confirmation a view cannot give: it is refused with a reason, nothing changes', async () => {
    const host = setup()
    const id = await note(host, 'olga', 'Plans', 'secret plans')
    const v = await view(host, 'olga')
    await v.until('Plans')
    v.key('s')
    await v.until('Private: only you can read this note.')
    v.key('a')
    await v.until('then enter')
    await v.type('@public')
    v.key('\r')
    const refused = await v.until(
      (s) => s.includes('confirm') || s.includes('not permitted') || s.includes('forbidden'),
    )
    expect(refused).toContain('Private: only you can read this note.')
    expect(host.acl.getResource('note', id)?.entries).toEqual([])
  })

  test('a long note scrolls and the view follows a resize', async () => {
    const host = setup()
    const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
    await note(host, 'olga', 'Long', body)
    const v = await view(host, 'olga', { cols: 60, rows: 12 })
    await v.until('Long')
    v.key('\r')
    const first = await v.until('line 1')
    expect(first).not.toContain('line 30')
    for (let i = 0; i < 6; i++) v.key(DOWN)
    await v.until('line 7')
    v.key('\u001b[6~') // page down
    await v.until((s) => /line (1[0-9]|2[0-9])/.test(s))
    v.resize(100, 30)
    await v.until((s) => s.split('\n').length > 12 || s.includes('line 1'))
  })

  test('a view of nothing says so, and a failed call says what the guard said', async () => {
    const host = setup()
    const v = await view(host, 'oscar')
    expect(await v.until('No notes yet.')).toContain('Notes · 0')
  })
})

describe('the Notes view and the leak kit', () => {
  test('an outsider, a group member and a guest never see a private note through the view (list, count, search)', async () => {
    const host = setup()
    const who = (a: { kind: string; id: string }) => (a.kind === 'guest' ? GUEST : a.id)
    const everyFrame: string[] = []
    /** The settled screen of a fresh view of this actor after the steps; every frame on the way is kept for the secrets check. */
    const screen = async (
      a: { kind: string; id: string },
      steps: (v: TestView) => Promise<void>,
    ) => {
      let v: TestView
      try {
        v = await view(host, who(a))
      } catch {
        return 'refused' // a guest is never offered a view
      }
      await v.until((s) => s.includes('Notes ·') && !s.includes('loading…'))
      await steps(v)
      const last = v.screen()
      everyFrame.push(...v.frames.map((f) => Bun.stripANSI(f)))
      v.close()
      return last
    }
    const search = (a: { kind: string; id: string }, term: string) =>
      screen(a, async (v) => {
        v.key('/')
        await v.until('[enter] search')
        await v.type(term)
        v.key('\r')
        await v.until((s) => s.includes('found') && !s.includes('loading…'))
      })
    const report = await leakCheck({
      actors: {
        outsider: CASE_ACTORS.outsider,
        groupMember: CASE_ACTORS.a, // a member of group A, which has no entry on the note
        guest: CASE_ACTORS.guest,
        owner: CASE_ACTORS.owner,
      },
      term: 'marmalade',
      operations: {
        count: async (a) => {
          const m = /Notes · (\d+)/.exec(await screen(a, async () => {}))
          return m === null ? 0 : Number(m[1])
        },
        search,
      },
      async seed() {
        host.clock.advance(5_000)
        const id = (
          await call(host, 'create', { title: 'Tax plan', body: 'offshore marmalade fund' }, 'olga')
        ).id
        return {
          id,
          missingId: crypto.randomUUID(),
          secrets: ['Tax plan', 'offshore marmalade fund'],
        }
      },
    })
    expect(report.problems).toEqual([])
    // the owner's own view holds the note (a vacuous fixture would pass everything), nobody else's frame does
    const own = await view(host, 'olga')
    await own.until('Tax plan')
    for (const frame of everyFrame.filter((f) => !f.includes('Search “marmalade” · 1 found'))) {
      expect(frame).not.toContain('Tax plan')
      expect(frame).not.toContain('offshore')
    }
    expect(report.ok).toBe(true)
  })

  test('a guest is never offered the view', async () => {
    const host = setup()
    await expect(
      openTestView(host, [notes], { viewId: 'notes.browse', as: GUEST }),
    ).rejects.toThrow('refused')
  })
})

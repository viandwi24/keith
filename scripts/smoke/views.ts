/**
 * P18 steps of the smoke test (docs/plans/done/P18): plugin terminal views against the real core, with a plain
 * `WebSocket` (scripts import no workspace package, so the wire protocol is spelled out here).
 *
 *  - the menu lists Notes and Reminders for a member, and needs a credential;
 *  - the Notes view opens over `/plugins/views/ws`, shows the viewer's own note after a key, and the text of every
 *    frame holds nothing but text, newlines and SGR: no ESC outside a colour sequence, no C0 or C1 control, no bidi
 *    override (the sanitiser's allow-list, checked here on what the server really sends);
 *  - an outsider's view of the same plugin never carries the author's private note;
 *  - the open is audited with ids only (`plugin.view.open`), the doctor lists a view that is open, and the owner opens
 *    the view on the local Unix socket (`ws+unix`) with no credential;
 *  - the guest listener has no `/plugins` (that check lives in `guests.ts`, where the listener is up).
 */

import type { SmokePeople } from './plugins.ts'
import { until } from './proc.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

export interface ViewsContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  ok(ran: Promise<{ code: number; out: string }>, what: string): Promise<string>
  admin(...args: string[]): Promise<{ code: number; out: string }>
  coreUrl: string
  /** The owner-only Unix socket of the running core. */
  socketPath: string
  people: SmokePeople
  /** The text of the private note that `hana` wrote in the plugin steps (an outsider must never see it). */
  secretTitle: string
  secretBody: string
}

const ESC = String.fromCharCode(27)

/** Everything a frame may hold: text, newline and SGR (`ESC [ digits ; : m`). Anything else is a violation. */
export function frameViolation(text: string): string | undefined {
  const bare = text.replace(new RegExp(`${ESC}\\[[0-9;:]*m`, 'g'), '')
  for (const ch of bare) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x0a) continue
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f))
      return `control U+${code.toString(16).padStart(4, '0')}`
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069))
      return `bidi override U+${code.toString(16)}`
  }
  return undefined
}

interface Viewer {
  frames: string[]
  closed: string | undefined
  send(message: unknown): void
  screen(): string
  until(check: (screen: string) => boolean, ms?: number): Promise<string>
  close(): void
}

/** Open a view with a plain `WebSocket`; `socketPath` picks the Unix socket (Bun's `ws+unix`). */
async function openView(
  target: { url: string; token?: string; socketPath?: string },
  viewId: string,
): Promise<Viewer> {
  const url =
    target.socketPath === undefined
      ? `${target.url.replace('http', 'ws')}/plugins/views/ws`
      : `ws+unix://${target.socketPath}:/plugins/views/ws`
  const ws = new WebSocket(
    url,
    target.token === undefined
      ? undefined
      : ({ headers: { authorization: `Bearer ${target.token}` } } as never),
  )
  const v: Viewer = {
    frames: [],
    closed: undefined,
    send: (m) => ws.send(JSON.stringify(m)),
    // what a person reads: the frame without its colour sequences
    screen: () => (v.frames.at(-1) ?? '').replace(new RegExp(`${ESC}\\[[0-9;:]*m`, 'g'), ''),
    async until(check, ms = 10_000) {
      for (const end = Date.now() + ms; !check(v.screen()); await Bun.sleep(25))
        if (Date.now() > end)
          throw new Error(
            `the view never showed it (closed: ${v.closed}); last frame:\n${v.screen()}`,
          )
      return v.screen()
    },
    close: () => ws.close(),
  }
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { type: string; text?: string; reason?: string }
    if (m.type === 'frame') v.frames.push(m.text ?? '')
    if (m.type === 'closed') v.closed = m.reason
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error(`the socket did not open (${url})`))
  })
  v.send({ v: 1, type: 'hello', viewId, cols: 80, rows: 20, colorDepth: 24 })
  return v
}

export async function viewSteps(c: ViewsContext): Promise<void> {
  const hana = c.people.get('hana')?.token ?? ''
  const gio = c.people.get('gio')?.token ?? ''
  assert(hana !== '' && gio !== '', 'the plugin steps did not leave hana and gio')

  await c.step(
    'views: the menu lists Notes and Reminders for a member and needs a credential',
    async () => {
      const res = await fetch(`${c.coreUrl}/plugins/tui/menu`, {
        headers: { authorization: `Bearer ${hana}` },
      })
      assert(res.status === 200, `the menu answered ${res.status}`)
      const ids = ((await res.json()) as { items: Array<{ viewId: string }> }).items.map(
        (i) => i.viewId,
      )
      for (const id of ['notes.browse', 'reminders.list'])
        assert(ids.includes(id), `the menu does not list ${id}: ${ids.join(', ')}`)
      assert(
        (await fetch(`${c.coreUrl}/plugins/tui/menu`)).status === 401,
        'the menu without a credential',
      )
    },
  )

  await c.step(
    'views: the Notes view opens over the socket, a key moves it, every frame is text and SGR only',
    async () => {
      const v = await openView({ url: c.coreUrl, token: hana }, 'notes.browse')
      const list = await v.until((s) => s.includes('Plan') && s.includes('Notes ·'))
      assert(list.includes('[enter] read'), `no key hints in the frame:\n${list}`)
      await Bun.sleep(150) // the input handler attaches a moment after the frame
      v.send({ type: 'key', data: 'j' }) // newest first: the public note is on top, the private one is next
      await Bun.sleep(100)
      v.send({ type: 'key', data: '\r' }) // read the selected note
      const read = await v.until((s) => s.includes(c.secretBody))
      assert(read.includes('[b] back'), `the reader shows no back key:\n${read}`)
      await Bun.sleep(100)
      v.send({ type: 'key', data: 'b' })
      await v.until((s) => s.includes('Notes ·'))
      for (const frame of v.frames) {
        const bad = frameViolation(frame)
        assert(bad === undefined, `a frame holds a ${bad}`)
      }
      v.send({ type: 'close' })
      await until(async () => v.closed !== undefined, 5_000, 'the close')
      assert(v.closed === 'view', `the view closed as ${v.closed}`)
    },
  )

  await c.step(
    "views: an outsider's view never carries the author's private note; the open is audited with ids only",
    async () => {
      const v = await openView({ url: c.coreUrl, token: gio }, 'notes.browse')
      await v.until((s) => s.includes('Notes ·') && !s.includes('loading'))
      v.send({ type: 'key', data: '/' })
      await Bun.sleep(150)
      for (const ch of c.secretBody.slice(0, 12)) v.send({ type: 'key', data: ch })
      v.send({ type: 'key', data: '\r' })
      await v.until((s) => s.includes('found') && !s.includes('loading'))
      for (const frame of v.frames) {
        assert(!frame.includes(c.secretBody), 'the outsider saw the private note text')
        assert(frameViolation(frame) === undefined, 'a frame of the outsider has a stray control')
      }
      v.send({ type: 'close' })
      await until(async () => v.closed !== undefined, 5_000, 'the close')
      const audit = await c.ok(c.admin('audit', '--limit', '300'), 'audit')
      assert(audit.includes('plugin.view.open'), 'no plugin.view.open row')
      assert(audit.includes('plugin.view.close'), 'no plugin.view.close row')
      for (const secret of [c.secretBody, c.secretTitle])
        assert(!audit.includes(secret), 'the audit log holds view content')
    },
  )

  await c.step(
    'views: the owner opens the view on the local socket with no credential; the doctor lists it',
    async () => {
      const v = await openView({ url: c.coreUrl, socketPath: c.socketPath }, 'notes.browse')
      await v.until((s) => s.includes('Notes ·'))
      const doctor = await c.ok(c.admin('doctor', '--offline'), 'doctor')
      assert(
        /plugin views — 1 open: notes\.browse for /.test(doctor),
        `doctor does not list the view:\n${doctor}`,
      )
      v.send({ type: 'close' })
      await until(async () => v.closed !== undefined, 5_000, 'the close')
    },
  )
}

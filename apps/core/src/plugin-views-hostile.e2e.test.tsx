/**
 * A hostile plugin view over the real server and the real client (P18 gate): the bytes it prints do reach the wire (the
 * server does not clean them: it cannot tell), and `@keith/client` drops every one of them, so no UI can pass an escape on
 * to a terminal. A frame over the cap closes the view with `limit`. Terminal level proof: `apps/tui/src/cli.view.pty.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createKeithClient, type ParsedFrame, type ViewEndReason } from '@keith/client'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { HOSTILE_BYTES, hostilePlugin } from '@keith/host/testing'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'

let booted: BootedCore
let db: Sqlite
let token = ''

beforeAll(async () => {
  booted = await bootCore({}, { plugins: [hostilePlugin] })
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' }).dbFile)
  const who = await booted.local.rpc.auth.whoami()
  token = (
    await createCredential(credentialsRepo(db), {
      personId: who.personId,
      kind: 'token',
      label: 'test',
    })
  ).token
})
afterAll(async () => {
  db.close()
  await booted.stop()
})

const ESC = '\u001b'
const client = () => createKeithClient({ baseUrl: booted.url, token })

async function open(viewId: string, params?: Record<string, string>) {
  const frames: ParsedFrame[] = []
  let ended: ViewEndReason | undefined
  const view = client().openView({
    viewId,
    cols: 100,
    rows: 40,
    ...(params === undefined ? {} : { params }),
    onFrame: (f) => frames.push(f),
    onEnd: (r) => {
      ended = r
    },
  })
  const until = async (check: () => boolean, ms = 6000) => {
    for (const end = Date.now() + ms; !check(); await Bun.sleep(20))
      if (Date.now() > end) throw new Error(`timed out (ended: ${ended})`)
  }
  return { view, frames, until, ended: () => ended }
}

describe('hostile views', () => {
  test('the bytes reach the wire, and the client drops every one of them', async () => {
    // the raw wire: a plain WebSocket sees what the server sent
    const wire: string[] = []
    const ws = new WebSocket(`${booted.url.replace('http', 'ws')}/plugins/views/ws`, {
      headers: { authorization: `Bearer ${token}` },
    } as never)
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { type: string; text?: string }
      if (m.type === 'frame') wire.push(m.text ?? '')
    }
    await new Promise<void>((r) => {
      ws.onopen = () => r()
    })
    ws.send(
      JSON.stringify({
        v: 1,
        type: 'hello',
        viewId: 'hostile.raw',
        cols: 100,
        rows: 20,
        colorDepth: 24,
      }),
    )
    for (let i = 0; i < 100 && !wire.join('').includes('pwned-title'); i++) await Bun.sleep(30)
    ws.close()
    const raw = wire.join('')
    // at least some of the attack is on the wire (Ink scrubs only what is inside Text)
    expect(raw).toContain(`${ESC}]52;c;`)
    expect(raw).toContain(`${ESC}]0;pwned-title`)

    // the client: the same view, parsed
    const c = await open('hostile.raw')
    await c.until(() =>
      c.frames.some((f) => f.lines.some((l) => l.some((r) => r.text.includes('honest text')))),
    )
    const texts = c.frames.flatMap((f) => f.lines.flatMap((l) => l.map((r) => r.text))).join('\n')
    expect(texts).toContain('honest text after the attack')
    // no escape, no C0/C1 control, no bidi override, no payload of a dropped sequence
    expect(texts).not.toContain(ESC)
    for (const ch of texts) {
      const code = ch.codePointAt(0) ?? 0
      const control = (code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)
      const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
      expect(control || bidi, `U+${code.toString(16)}`).toBe(false)
    }
    for (const bad of ['aGlqYWNrZWQ', 'pwned-title', 'evil.example', 'AAAA'])
      expect(texts, bad).not.toContain(bad)
    c.view.close()
    await c.until(() => c.ended() !== undefined)
    expect(HOSTILE_BYTES.length).toBeGreaterThan(5)
  })

  test('a frame over the cap closes the view with limit and nothing of it reaches the client', async () => {
    const c = await open('hostile.flood', { lines: '3000' })
    await c.until(() => c.ended() !== undefined)
    expect(c.ended()).toBe('limit')
    expect(c.frames).toEqual([])
  })

  test('a view asks the platform for its handle and gets only viewId, call and events', async () => {
    const c = await open('hostile.greedy')
    await c.until(() => c.frames.length > 0)
    const text = c.frames.flatMap((f) => f.lines.flatMap((l) => l.map((r) => r.text))).join('')
    expect(text).toBe('call,events,viewId')
    c.view.close()
  })
})

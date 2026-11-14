/**
 * P17 steps of the smoke test (docs/plans/done/P17-guest-mode.md): guest mode end to end against the real core
 * process, with plain `fetch` on the guest listener, the real `keith-core` and `keith` CLIs, and ONE real
 * pseudo-terminal step (`keith --guest`). Scripts import no workspace package, so the contract is spelled out here.
 *
 * How the smoke gets what guest mode needs:
 *  - **A priced guest model.** Enabling guests is refused for an unpriced model. The fake provider answers whatever
 *    model id it is asked for, so the smoke gives the guest role a catalog id on the same connection
 *    (`deepseek:deepseek-chat`, priced by the smoke's own catalog: the fake provider serves `/api.json`, wired through
 *    `KEITH_MODELS_DEV_URL`; the real models.dev dropped that id, so the smoke must never depend on it) while the front and cortex roles stay on the unpriced `smoke` model. The
 *    smoke also shows the refusal for `deepseek:smoke` first.
 *  - **The loopback zone.** Everything here runs on one machine, so the visitor is a loopback peer. The default
 *    zones (`lan`) refuse it (`GUEST_ZONE`); the step then adds `loopback` to `guests.zones` (a step-up call), which
 *    is what an owner would do to test from the same machine.
 *  - **A free port.** `guests.port` is set to a free port (the default 7421 may be taken).
 *  - **Public notes.** The owner creates one public and one private note over the plugin routes; the fake provider
 *    answers a guest's question about "public notes" by calling `notes_public_list` and repeating what it returned.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { freePort, until } from './proc.ts'
import { FRESH_PIN } from './sign-in.ts'
import { cleanEnv, startTui } from './tui.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

export interface GuestsContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  ok(ran: Promise<{ code: number; out: string }>, what: string): Promise<string>
  admin(...args: string[]): Promise<{ code: number; out: string }>
  tmp: string
  home: string
  dataDir: string
  coreUrl: string
  context(fn: () => string): void
  output(): string
}

const json = { 'content-type': 'application/json' }
/** The fields of the one audit row a guest session leaves (`GuestSessionAuditSchema`, strict). */
const AUDIT_FIELDS = [
  'clientKind',
  'costUsd',
  'endedAt',
  'guestId',
  'inputTokens',
  'ipHash',
  'outputTokens',
  'reason',
  'refusals',
  'startedAt',
  'tools',
  'turns',
  'zone',
]

interface Reply {
  status: number
  text: string
  headers: Headers
  body: string
}

export async function guestSteps(c: GuestsContext): Promise<void> {
  const gport = await freePort()
  const guestUrl = `http://127.0.0.1:${gport}`
  const uid = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10)
  // built at runtime: typed by the visitor, echoed by the model, searched for in every durable place
  const sentinel = `guestword${uid()}`
  // one word, so a wrapped line in the terminal cannot split it
  const publicTitle = `OpenHours${uid()}`
  const privateTitle = `Diary${uid()}`
  const privateBody = `a secret ${uid()}`

  let cold = ''
  const owner = (path: string, body: unknown = {}) =>
    fetch(`${c.coreUrl}/rpc/${path}`, {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${cold}` },
      body: JSON.stringify({ json: body }),
    })
  const setGuests = async (patch: Record<string, unknown>) => {
    const res = await owner('admin/guests/set', patch)
    assert(
      res.status === 200,
      `admin.guests.set ${JSON.stringify(patch)} answered ${res.status}: ${await res.text()}`,
    )
  }
  const guestFetch = (path: string, init: RequestInit = {}) => fetch(`${guestUrl}${path}`, init)
  const status = async () =>
    (await (await guestFetch('/guest/status')).json()) as {
      enabled: boolean
      available: boolean
      banner: string
    }
  const open = () => guestFetch('/guest/session', { method: 'POST', headers: json, body: '{}' })
  // the guest listener is reconciled on a ~2 s poll: every step that sends to the guest port waits for it first
  const ready = () =>
    until(
      async () => (await guestFetch('/health').catch(() => null))?.ok === true,
      15_000,
      'the guest listener',
      () => `core output:\n${c.output()}`,
    )
  let session = { id: '', token: '' }
  const chat = async (text: string): Promise<Reply> => {
    const res = await guestFetch(`/guest/sessions/${encodeURIComponent(session.id)}/chat`, {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        id: session.id,
        trigger: 'submit-message',
        messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
      }),
    })
    const body = await res.text()
    let reply = ''
    for (const line of body.split('\n')) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
      try {
        const part = JSON.parse(line.slice(6)) as { type?: string; delta?: string }
        if (part.type === 'text-delta') reply += part.delta ?? ''
      } catch {
        // not a chunk
      }
    }
    return { status: res.status, text: reply, headers: res.headers, body }
  }
  const live = async (): Promise<string[]> => {
    const out = await c.ok(c.admin('guests', 'list'), 'guests list')
    return out
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/)[0] ?? '')
      .filter((id) => id !== '' && id !== 'no')
  }

  await c.step(
    'guests: enable is refused without a priced model and needs a step-up; then the port is chosen',
    async () => {
      const none = await c.admin('guests', 'enable')
      assert(none.code !== 0 && /model/i.test(none.out), `enable with no model:\n${none.out}`)
      await c.ok(c.admin('model', 'set', 'guest', 'deepseek:smoke'), 'model set guest (unpriced)')
      const unpriced = await c.admin('guests', 'enable')
      assert(
        unpriced.code !== 0 && /unpriced|price/i.test(unpriced.out),
        `enable with an unpriced model:\n${unpriced.out}`,
      )
      await c.ok(c.admin('model', 'set', 'guest', 'deepseek:deepseek-chat'), 'model set guest')
      // a cold owner credential: the settings call is sensitive, so it needs the PIN first
      const made = await c.ok(c.admin('token', 'create', '--label', 'guests'), 'token create')
      cold = /(keith_s_\S+)/.exec(made)?.[1] ?? ''
      assert(cold !== '', `no credential in:\n${made}`)
      const refused = await owner('admin/guests/set', { port: gport })
      const refusedBody = await refused.text()
      assert(
        refused.status === 403 && refusedBody.includes('KEITH_STEP_UP_REQUIRED'),
        `a cold credential changed guest settings: ${refused.status} ${refusedBody}`,
      )
      // the owner's PIN at this point of the smoke is the one the P14 steps set
      const up = await fetch(`${c.coreUrl}/auth/step-up`, {
        method: 'POST',
        headers: { ...json, authorization: `Bearer ${cold}` },
        body: JSON.stringify({ pin: FRESH_PIN }),
      })
      assert(up.status === 200, `step-up of the owner credential answered ${up.status}`)
      await setGuests({ port: gport, sessionsPerIpPerWindow: 20 })
      const enabled = await c.ok(c.admin('guests', 'enable'), 'guests enable')
      assert(/guests: on/.test(enabled), `guests enable did not turn them on:\n${enabled}`)
      c.context(() => `core output:\n${c.output()}`)
      await ready()
      // the owner API is not on the guest port, and the guest API is not on the owner's port
      assert(
        (await guestFetch('/rpc/health/get', { method: 'POST' })).status === 404,
        '/rpc on the guest port',
      )
      assert((await fetch(`${c.coreUrl}/guest/status`)).status === 404, '/guest on the owner port')
      // plugin terminal views (P18): the guest listener has no /plugins at all, menu and socket alike
      for (const path of ['/plugins/tui/menu', '/plugins/views/ws'])
        assert((await guestFetch(path)).status === 404, `${path} on the guest port`)
    },
  )

  await c.step(
    'guests: the default zone refuses this machine; allowed once guests.zones includes loopback',
    async () => {
      // the smoke runs on loopback and the default zones are `lan` only
      await ready()
      const denied = await status()
      assert(
        !denied.enabled && !denied.available,
        `status for a refused zone: ${JSON.stringify(denied)}`,
      )
      const refused = await open()
      const body = (await refused.json()) as { error?: { code?: string } }
      assert(
        refused.status === 403 && body.error?.code === 'GUEST_ZONE',
        `a loopback visitor under zones=lan: ${refused.status} ${JSON.stringify(body)}`,
      )
      await setGuests({ zones: ['lan', 'loopback'] })
      await ready()
      const allowed = await status()
      assert(
        allowed.enabled && allowed.available,
        `status after allowing loopback: ${JSON.stringify(allowed)}`,
      )
      assert(
        allowed.banner.includes('owner can watch'),
        'the status banner does not say the owner can watch',
      )
      const proxied = await guestFetch('/guest/session', {
        method: 'POST',
        headers: { ...json, 'x-forwarded-for': '9.9.9.9' },
        body: '{}',
      })
      assert(proxied.status === 403, `a proxied loopback request was served: ${proxied.status}`)
    },
  )

  await c.step(
    'guests: a visitor sees only the public notes (and the stream names no model)',
    async () => {
      // the owner's notes: one public, one private
      const post = (path: string, body: unknown) =>
        fetch(`${c.coreUrl}/plugins/notes/${path}`, {
          method: 'POST',
          headers: { ...json, authorization: `Bearer ${cold}` },
          body: JSON.stringify(body),
        })
      const pub = (await (
        await post('create', { title: publicTitle, body: 'we open at nine' })
      ).json()) as { id: string }
      const priv = await post('create', { title: privateTitle, body: privateBody })
      assert(priv.status === 200, `creating the private note: ${priv.status}`)
      const shared = await post('share', { id: pub.id, target: '@public' })
      assert(shared.status === 200, `sharing publicly: ${shared.status} ${await shared.text()}`)

      await ready()
      const opened = await open()
      const started = (await opened.json()) as { sessionId: string; token: string; notice: string }
      assert(opened.status === 201, `start answered ${opened.status}: ${JSON.stringify(started)}`)
      assert(started.token.startsWith('keith_g_'), 'the guest bearer has no keith_g_ prefix')
      assert(
        started.notice.includes('not store'),
        'the start notice does not say nothing is stored',
      )
      session = { id: started.sessionId, token: started.token }

      const first = await chat(`what are the public notes? ${sentinel}`)
      assert(
        first.status === 200,
        `guest chat answered ${first.status}: ${first.body.slice(0, 300)}`,
      )
      assert(
        first.text.includes(publicTitle),
        `the public note is not in the answer:\n${first.text}`,
      )
      assert(first.text.includes(sentinel), 'the model did not echo the visitor sentinel')
      for (const secret of [privateTitle, privateBody])
        assert(!first.text.includes(secret), `a private note reached a visitor: ${secret}`)
      for (const word of ['deepseek', 'costUsd', 'pricing'])
        assert(!first.body.includes(word), `the guest stream names ${word}`)
      assert(first.headers.get('x-keith-guest-turns-left') === '19', 'turns left is not 19')
      assert(first.headers.get('x-keith-guest-watched') === null, 'watched before any peek')
    },
  )

  await c.step(
    'guests: the owner lists and peeks at the live session; the visitor is told',
    async () => {
      const ids = await live()
      assert(ids.length === 1, `expected one live guest session, got ${JSON.stringify(ids)}`)
      const peek = await c.ok(c.admin('guests', 'peek', ids[0] ?? ''), 'guests peek')
      assert(
        peek.includes(sentinel) && peek.includes(publicTitle),
        `peek does not show the chat:\n${peek}`,
      )
      await ready()
      const next = await chat('thanks')
      assert(
        next.headers.get('x-keith-guest-watched') === '1',
        'the visitor was not told about the peek',
      )
      assert(next.headers.get('x-keith-guest-turns-left') === '18', 'turns left is not 18')
    },
  )

  await c.step('guests: the real TUI `keith --guest` chats against the guest port', async () => {
    const env = cleanEnv({
      HOME: c.home,
      // no login file at all: a visitor needs none
      KEITH_CLIENT_CONFIG: join(c.tmp, 'no-such-client.json'),
      KEITH_DATA_DIR: join(c.tmp, 'no-such-data'),
    })
    const before = (await live()).length
    await ready()
    const tui = await startTui(env, {
      args: ['--guest', '--core', guestUrl],
      ready: ['messages left'],
    })
    try {
      assert(tui.screen().includes('owner can watch a live session'), `no banner:\n${tui.screen()}`)
      await tui.say(`what are the public notes? ${sentinel}`)
      await until(
        () => tui.screen().includes(publicTitle),
        25_000,
        'the guest answer on screen',
        () => tui.screen(),
      )
      assert((await live()).length === before + 1, 'the TUI chat is not a live session')
      for (const word of [privateTitle, 'Tasks', 'Manage'])
        assert(!tui.screen().includes(word), `the guest screen shows ${word}`)
      tui.send('\u0003')
      await until(
        async () => (await live()).length === before,
        15_000,
        'the guest session to end on ctrl+c',
        () => tui.screen(),
      )
    } finally {
      await tui.stop()
    }
  })

  await c.step(
    'guests: a cap hit is 429, the kill switch ends the session (410) and refuses new ones',
    async () => {
      // far below what the turns above cost: the day is spent, so entry says so
      await setGuests({ dailyUsd: 0.000001 })
      await ready()
      const capped = await open()
      const cappedBody = (await capped.json()) as { error?: { code?: string } }
      assert(
        capped.status === 429 && cappedBody.error?.code === 'GUEST_CAP',
        `the daily cap: ${capped.status} ${JSON.stringify(cappedBody)}`,
      )
      assert(Number(capped.headers.get('retry-after')) > 0, 'no Retry-After on a cap')
      await setGuests({ dailyUsd: 0.5 })
      const killed = await c.ok(c.admin('guests', 'kill'), 'guests kill')
      assert(/ended/.test(killed), `kill output:\n${killed}`)
      // the kill switch also closes the guest port on the next listener poll (every 2 s): until then the live
      // session answers 410 and a new one 403, after it the port refuses the connection. Both prove the cut.
      const gone = await chat('are you there?').catch(() => undefined)
      if (gone !== undefined) {
        const goneBody = JSON.parse(gone.body) as {
          error?: { code?: string; details?: { reason?: string } }
        }
        assert(
          gone.status === 410 && goneBody.error?.details?.reason === 'killed',
          `the killed session: ${gone.status} ${gone.body.slice(0, 200)}`,
        )
      }
      const refused = await open().catch(() => undefined)
      if (refused !== undefined)
        assert(refused.status === 403, `a new session while killed: ${refused.status}`)
      const killedStatus = await status().catch(() => undefined)
      if (killedStatus !== undefined)
        assert(!killedStatus.enabled, 'status says enabled while killed')
      await c.ok(c.admin('guests', 'enable'), 'guests enable (lifts the kill switch)')
      // enabling reopens the port on the next poll too: wait for it before asking
      await until(
        async () => (await guestFetch('/health').catch(() => null))?.ok === true,
        15_000,
        'the guest listener after enable',
        () => `core output:\n${c.output()}`,
      )
      assert((await status()).available, 'guests are not available after enable')
    },
  )

  await c.step(
    'guests: one aggregate audit row per session with only the allowed fields; no text anywhere',
    async () => {
      const res = await owner('admin/audit/list', { limit: 400 })
      assert(res.status === 200, `audit list answered ${res.status}`)
      const rows = (
        (await res.json()) as { json: Array<{ kind: string; actor: string; detail: unknown }> }
      ).json
      const ends = rows.filter((r) => r.kind === 'guest.session.end')
      assert(ends.length >= 2, `expected the killed and the TUI session rows, got ${ends.length}`)
      for (const row of ends) {
        const keys = Object.keys(row.detail as object).sort()
        assert(
          JSON.stringify(keys) === JSON.stringify(AUDIT_FIELDS),
          `the guest session row has other fields:\n${JSON.stringify(keys)}`,
        )
        assert(row.actor.startsWith('guest:'), `the actor of a guest row is ${row.actor}`)
      }
      const reasons = ends.map((r) => (r.detail as { reason: string }).reason)
      assert(reasons.includes('killed') && reasons.includes('closed'), `end reasons: ${reasons}`)
      for (const kind of ['guest.settings', 'guest.killswitch', 'guest.peek'])
        assert(
          rows.some((r) => r.kind === kind),
          `the audit has no ${kind} row`,
        )
      const guestRows = JSON.stringify(rows.filter((r) => r.kind.startsWith('guest.')))
      for (const secret of [sentinel, publicTitle, privateTitle, '127.0.0.1'])
        assert(!guestRows.includes(secret), `a guest audit row holds ${secret}`)
      const cli = await c.ok(c.admin('audit', '--limit', '400'), 'audit')
      assert(!cli.includes(sentinel), 'the audit command prints what the visitor typed')
      // nothing a visitor said is in any file of the data folder (the database, its WAL, logs)
      const hits: string[] = []
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name)
          const info = statSync(path)
          if (info.isDirectory()) walk(path)
          else if (info.isFile() && readFileSync(path).includes(sentinel)) hits.push(path)
        }
      }
      walk(c.dataDir)
      assert(hits.length === 0, `the visitor's words are on disk: ${hits.join(', ')}`)
      assert(!c.output().includes(sentinel), 'the core logged what the visitor typed')
    },
  )
}

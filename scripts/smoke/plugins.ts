/**
 * P16 steps of the smoke test (docs/plans/done/P16): the plugin layer end to end, with plain `fetch` over the
 * plugin routes and the real `keith-core` and `keith` CLIs (scripts import no workspace package).
 *
 *  - `keith-core plugin list|show|enable|disable` (the toggle is saved and says it applies at the next boot);
 *  - Notes: a member's private note is invisible to an outsider (the same NOT_FOUND as a missing id, in get, list and
 *    search), a share to a group lets a group member read it and still not the outsider, a public share is read through
 *    `public_get` (and a private note is not), the owner's read of a private note is audited (`acl.owner-access`).
 *    This is the end-to-end ACL gate that P15 could not run for lack of a resource kind;
 *  - Reminders: a reminder that came due while the core was down fires once after the restart (a real file database),
 *    and a reminder for another person waits in `keith-core reviews list` until the owner approves it;
 *  - no note or reminder text reaches the audit log.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from './proc.ts'
import { cleanEnv } from './tui.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

export interface PluginsContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  run(
    cmd: string[],
    env: Record<string, string>,
    opts?: { stdin?: string },
  ): Promise<{ code: number; out: string }>
  ok(ran: Promise<{ code: number; out: string }>, what: string): Promise<string>
  admin(...args: string[]): Promise<{ code: number; out: string }>
  adminStdin(stdin: string, ...args: string[]): Promise<{ code: number; out: string }>
  tmp: string
  home: string
  coreUrl: string
  tuiBin: string[]
  ownerToken: string
  /** Stops the running core and starts a new one on the same data folder; resolves when it is healthy. */
  restartCore(whileDown: () => Promise<void>): Promise<void>
}

const json = { 'content-type': 'application/json' }

/** The people the steps made (name to password and `keith_s_` credential), for the steps that follow. */
export type SmokePeople = Map<string, { password: string; token: string }>

/** What the plugin steps leave for the steps that follow: the people, and the private note that `hana` wrote. */
export interface PluginSteps {
  people: SmokePeople
  noteTitle: string
  noteBody: string
}

export async function pluginSteps(c: PluginsContext): Promise<PluginSteps> {
  const sentinel = `sentinel-${crypto.randomUUID()}`
  const reminderText = `remind-${crypto.randomUUID()}`
  const pass = () => `slate-${crypto.randomUUID()}-willow`
  const people = new Map<string, { password: string; token: string }>()
  const post = (credential: string, path: string, body: unknown = {}) =>
    fetch(`${c.coreUrl}/plugins/${path}`, {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${credential}` },
      body: JSON.stringify(body),
    })
  const text = async (res: Response) => ({ status: res.status, body: await res.text() })
  const as = (name: string): string => people.get(name)?.token ?? ''

  await c.step(
    'plugin: list, show, disable and enable say they apply at the next boot',
    async () => {
      const list = await c.ok(c.admin('plugin', 'list'), 'plugin list')
      for (const id of ['notes', 'reminders'])
        assert(
          new RegExp(`${id}\\s+enabled\\b`).test(list),
          `plugin list does not show ${id} enabled:\n${list}`,
        )
      const show = await c.ok(c.admin('plugin', 'show', 'notes'), 'plugin show notes')
      for (const word of ['notes.use', 'public_get', 'share'])
        assert(show.includes(word), `plugin show notes does not mention ${word}:\n${show}`)
      const off = await c.ok(c.admin('plugin', 'disable', 'reminders', '--yes'), 'plugin disable')
      assert(/next boot/.test(off), `disable does not say it applies at the next boot:\n${off}`)
      const mid = await c.ok(c.admin('plugin', 'list'), 'plugin list after disable')
      assert(
        /enabled \(disabled at next boot\)/.test(mid),
        `list does not show the pending toggle:\n${mid}`,
      )
      await c.ok(c.admin('plugin', 'enable', 'reminders', '--yes'), 'plugin enable')
      assert(
        (await c.admin('plugin', 'show', 'nope')).code !== 0,
        'plugin show of an unknown id succeeded',
      )
    },
  )

  const addPerson = async (name: string): Promise<void> => {
    const password = pass()
    await c.ok(c.admin('people', 'add', name, '--name', name.toUpperCase()), `people add ${name}`)
    await c.ok(
      c.adminStdin(password, 'people', 'passwd', name, '--password-stdin'),
      `passwd ${name}`,
    )
    const file = join(c.tmp, `${name}-client.json`)
    await c.ok(
      c.run(
        [...c.tuiBin, 'login', '--password-stdin', '--username', name, '--core', c.coreUrl],
        cleanEnv({ HOME: c.home, KEITH_CLIENT_CONFIG: file }),
        { stdin: `${password}\n` },
      ),
      `login ${name}`,
    )
    const token = (JSON.parse(readFileSync(file, 'utf8')) as { token?: string }).token ?? ''
    assert(token.startsWith('keith_s_'), `${name} has no keith_s_ credential`)
    people.set(name, { password, token })
  }

  let noteId = ''
  await c.step(
    'notes: a private note is invisible to an outsider, identically to a missing id',
    async () => {
      await addPerson('hana') // the author
      await addPerson('gio') // the outsider
      await addPerson('fai') // a group member
      const made = await post(as('hana'), 'notes/create', { title: 'Plan', body: sentinel })
      assert(made.status === 200, `hana notes/create answered ${made.status}`)
      noteId = ((await made.json()) as { id: string }).id
      assert(
        (await post(as('hana'), 'notes/get', { id: noteId })).status === 200,
        'author cannot read',
      )
      const gone = crypto.randomUUID().replaceAll('-', '')
      const norm = (t: string, id: string) => t.replaceAll(id, '<id>')
      const mine = await text(await post(as('gio'), 'notes/get', { id: noteId }))
      const none = await text(await post(as('gio'), 'notes/get', { id: gone }))
      assert(mine.status === 404, `the outsider read the note: ${mine.status} ${mine.body}`)
      assert(
        mine.status === none.status && norm(mine.body, noteId) === norm(none.body, gone),
        `a private note and a missing id answer differently:\n${mine.body}\n${none.body}`,
      )
      const list = await text(await post(as('gio'), 'notes/list', {}))
      assert(!list.body.includes(noteId) && !list.body.includes(sentinel), 'the outsider lists it')
      const search = await text(await post(as('gio'), 'notes/search', { query: sentinel }))
      assert(
        !search.body.includes(noteId) && !search.body.includes('Plan'),
        'the outsider finds it',
      )
    },
  )

  await c.step('notes: a share to a group opens it to a member, not to the outsider', async () => {
    await c.ok(c.admin('groups', 'create', 'circle'), 'groups create circle')
    await c.ok(c.admin('groups', 'add', 'circle', 'fai'), 'groups add fai')
    const shared = await post(as('hana'), 'notes/share', {
      id: noteId,
      target: 'group:circle',
      access: 'read',
    })
    assert(
      shared.status === 200,
      `share to the group answered ${shared.status} ${await shared.text()}`,
    )
    const fai = await text(await post(as('fai'), 'notes/get', { id: noteId }))
    assert(
      fai.status === 200 && fai.body.includes(sentinel),
      `a group member cannot read: ${fai.status}`,
    )
    const gio = await post(as('gio'), 'notes/get', { id: noteId })
    assert(gio.status === 404, `the outsider reads a group share: ${gio.status}`)
    const seen = await text(await post(as('fai'), 'notes/list', {}))
    assert(seen.body.includes(noteId), 'the group member does not list the shared note')
  })

  await c.step(
    'notes: a public share is read through public_get; a private note is not',
    async () => {
      const hana = people.get('hana')
      assert(hana !== undefined, 'no hana')
      const up = await fetch(`${c.coreUrl}/auth/step-up`, {
        method: 'POST',
        headers: { ...json, authorization: `Bearer ${hana.token}` },
        body: JSON.stringify({ password: hana.password }),
      })
      assert(up.status === 200, `step-up of hana answered ${up.status}`)
      const open = await post(hana.token, 'notes/create', { title: 'Hello', body: 'for everyone' })
      const openId = ((await open.json()) as { id: string }).id
      const pub = await post(hana.token, 'notes/share', { id: openId, target: '@public' })
      assert(pub.status === 200, `the public share answered ${pub.status} ${await pub.text()}`)
      const read = await text(await post(as('gio'), 'notes/public_get', { id: openId }))
      assert(
        read.status === 200 && read.body.includes('for everyone'),
        `public_get: ${read.status}`,
      )
      const priv = await post(as('gio'), 'notes/public_get', { id: noteId })
      assert(priv.status === 404, `public_get of a group-only note answered ${priv.status}`)
      const none = await fetch(`${c.coreUrl}/plugins/notes/public_get`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ id: openId }),
      })
      assert(
        none.status === 401,
        `public_get without a credential answered ${none.status} (guests are P17)`,
      )
    },
  )

  await c.step('notes: the owner reads a private note and the read is audited', async () => {
    const own = await text(await post(c.ownerToken, 'notes/get', { id: noteId }))
    assert(own.status === 200, `the owner could not read: ${own.status} ${own.body}`)
    const audit = await c.ok(c.admin('audit', '--limit', '300'), 'audit')
    assert(audit.includes('acl.owner-access'), `no acl.owner-access row:\n${audit.slice(-1500)}`)
  })

  let reminderId = ''
  await c.step(
    'reminders: one that came due while the core was down fires once after the restart',
    async () => {
      const at = new Date(Date.now() + 3_000).toISOString()
      const made = await text(
        await post(as('hana'), 'reminders/create', { text: reminderText, at }),
      )
      assert(made.status === 200, `reminders/create answered ${made.status} ${made.body}`)
      reminderId = (JSON.parse(made.body) as { id: string }).id
      await c.restartCore(async () => {
        await Bun.sleep(4_500) // the slot passes while nothing runs
      })
      const fired = async () =>
        (await c.admin('audit', '--limit', '300')).out
          .split('\n')
          .filter((l) => l.includes('plugin.reminders.fired') && l.includes(reminderId)).length
      await until(async () => (await fired()) >= 1, 20_000, 'the missed reminder to fire')
      await Bun.sleep(1_500)
      assert((await fired()) === 1, `the reminder fired ${await fired()} times, expected once`)
    },
  )

  await c.step(
    'reminders: a request for another person waits in reviews list until approved',
    async () => {
      const held = await post(as('hana'), 'reminders/create', {
        text: reminderText,
        inMinutes: 60,
        to: 'gio',
      })
      assert(held.status === 202, `a reminder for gio answered ${held.status}, expected 202`)
      const list = await c.ok(c.admin('reviews', 'list'), 'reviews list')
      const row = list.split('\n').find((l) => l.includes('reminders.create') && l.includes('hana'))
      assert(row !== undefined, `reviews list does not show the request:\n${list}`)
      const id = row.trim().split(/\s+/)[0] ?? ''
      const done = await c.ok(c.admin('reviews', 'approve', id), 'reviews approve')
      assert(done.includes('approved'), `reviews approve: ${done}`)
      const after = await c.ok(c.admin('reviews', 'list'), 'reviews list after')
      assert(after.includes('nothing is waiting'), `the review is still pending:\n${after}`)
    },
  )

  await c.step('no note or reminder text reaches the audit log', async () => {
    const audit = await c.ok(c.admin('audit', '--limit', '500'), 'audit')
    for (const secret of [sentinel, reminderText, 'for everyone'])
      assert(!audit.includes(secret), `the audit log holds plugin content: ${secret}`)
    for (const kind of ['plugin.notes', 'plugin.reminders', 'plugin.review.approved'])
      assert(audit.includes(kind), `audit does not list ${kind}`)
  })
  return { people, noteTitle: 'Plan', noteBody: sentinel }
}

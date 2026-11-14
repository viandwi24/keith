/**
 * P15 steps of the smoke test (docs/plans/done/P15): groups through the real `keith-core` and over
 * TCP, the audit trail of group changes, the audit retention knob, and the "not found" rule of
 * `acl.*` for a member. Plain `fetch` and the real CLIs only: scripts import no workspace package.
 *
 * What this cannot prove yet: core registers no resource kind until the plugin layer (P16), so no
 * real resource exists to share, read, or have audited as an owner access. Those paths are covered by
 * the `@keith/acl` conformance and leak kits and by the core's own tests; the end-to-end version
 * (share, a member reads, an outsider gets not found, the owner's look is audited) joins this step
 * with the Notes plugin.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanEnv } from './tui.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

export interface AclContext {
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
}

const json = { 'content-type': 'application/json' }

export async function aclSteps(c: AclContext): Promise<void> {
  const passphrase = `slate-${crypto.randomUUID()}-orchard`
  const clientFile = join(c.tmp, 'duta-client.json')
  const dutaEnv = cleanEnv({ HOME: c.home, KEITH_CLIENT_CONFIG: clientFile })
  let duta = ''
  const rpc = (credential: string, path: string, input: unknown = null) =>
    fetch(`${c.coreUrl}/rpc/${path}`, {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${credential}` },
      body: JSON.stringify({ json: input }),
    })

  await c.step(
    'groups: create, add a member, list, remove, delete through keith-core',
    async () => {
      await c.ok(c.admin('people', 'add', 'duta', '--name', 'Duta'), 'people add duta')
      await c.ok(
        c.adminStdin(passphrase, 'people', 'passwd', 'duta', '--password-stdin'),
        'passwd duta',
      )
      await c.ok(c.admin('groups', 'create', 'friends'), 'groups create')
      const added = await c.ok(c.admin('groups', 'add', 'friends', 'duta'), 'groups add')
      assert(added.includes('duta'), `groups add does not name duta:\n${added}`)
      const list = await c.ok(c.admin('groups', 'list'), 'groups list')
      assert(/friends\s+1\s+0\b/.test(list), `groups list: one member, used by none:\n${list}`)
      const dup = await c.admin('groups', 'create', 'friends')
      assert(dup.code !== 0, 'creating the same group twice succeeded')
      await c.ok(c.admin('groups', 'remove', 'friends', 'duta'), 'groups remove')
      const empty = await c.ok(c.admin('groups', 'show', 'friends'), 'groups show')
      assert(!empty.includes('duta'), `duta is still in friends:\n${empty}`)
      await c.ok(c.admin('groups', 'delete', 'friends', '--yes'), 'groups delete')
      const gone = await c.ok(c.admin('groups', 'list'), 'groups list after delete')
      assert(!gone.includes('friends'), `friends is still listed:\n${gone}`)
    },
  )

  await c.step(
    'a member cannot manage groups or the retention over TCP (403 FORBIDDEN)',
    async () => {
      await c.ok(
        c.run(
          [...c.tuiBin, 'login', '--password-stdin', '--username', 'duta', '--core', c.coreUrl],
          dutaEnv,
          { stdin: `${passphrase}\n` },
        ),
        'login duta',
      )
      duta = (JSON.parse(readFileSync(clientFile, 'utf8')) as { token?: string }).token ?? ''
      assert(duta.startsWith('keith_s_'), 'duta has no keith_s_ credential')
      const calls: Array<[string, unknown]> = [
        ['admin/groups/list', null],
        ['admin/groups/create', { name: 'sneaky' }],
        ['admin/audit/retention/get', null],
        ['admin/audit/retention/set', { days: 1 }],
      ]
      for (const [path, input] of calls) {
        const res = await rpc(duta, path, input)
        assert(res.status === 403, `duta on ${path} answered ${res.status}, expected 403`)
        assert((await res.text()).includes('FORBIDDEN'), `${path} refusal is not FORBIDDEN`)
      }
      const after = await c.ok(c.admin('groups', 'list'), 'groups list')
      assert(!after.includes('sneaky'), 'a member created a group')
    },
  )

  await c.step(
    'acl: a member gets the same not found for a missing kind and a missing id',
    async () => {
      const ask = async (kind: string, id: string) => {
        const res = await rpc(duta, 'acl/show', { kind, id })
        return { status: res.status, body: (await res.text()).replaceAll(id, '<id>') }
      }
      const noKind = await ask('note', crypto.randomUUID().replaceAll('-', ''))
      const noId = await ask('reminder', crypto.randomUUID().replaceAll('-', ''))
      assert(noKind.status === 404, `acl show on a missing kind answered ${noKind.status}`)
      assert(noId.status === 404, `acl show on a missing id answered ${noId.status}`)
      assert(noKind.body.includes('NOT_FOUND'), `not the procedure's refusal:\n${noKind.body}`)
      assert(
        noKind.body.replace('note', 'reminder') === noId.body,
        `the two refusals differ:\n${noKind.body}\n${noId.body}`,
      )
    },
  )

  await c.step(
    'audit retention: show, set, set 0 (keeps everything), a bad value is refused',
    async () => {
      const shown = await c.ok(c.admin('audit', 'retention', 'show'), 'retention show')
      assert(/180/.test(shown), `retention show does not say 180:\n${shown}`)
      await c.ok(c.admin('audit', 'retention', 'set', '90'), 'retention set 90')
      assert(
        /90/.test(await c.ok(c.admin('audit', 'retention', 'show'), 'retention show')),
        'retention did not change to 90',
      )
      await c.ok(c.admin('audit', 'retention', 'set', '0'), 'retention set 0')
      assert(
        (await c.admin('audit', 'retention', 'set', '9999')).code !== 0,
        'retention set 9999 succeeded',
      )
      await c.ok(c.admin('audit', 'retention', 'set', '180'), 'retention restore')
    },
  )

  await c.step(
    'audit lists the group changes and the retention change, with no content',
    async () => {
      const out = await c.ok(c.admin('audit', '--limit', '300'), 'audit')
      for (const kind of [
        'acl.group.create',
        'acl.group.add',
        'acl.group.remove',
        'acl.group.delete',
      ])
        assert(out.includes(kind), `audit does not list ${kind}:\n${out}`)
      assert(out.includes('audit.retention.set'), 'audit does not list audit.retention.set')
      assert(!out.includes(passphrase), 'the audit holds a passphrase')
    },
  )
}

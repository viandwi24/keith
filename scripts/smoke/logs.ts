/**
 * P36.6.1 steps of the smoke test (docs/specs/activity-logs.md): the model-call log. The owner lists the chat session of
 * the owner's TUI chat; a member sees only their own sessions and gets NOT_FOUND on the owner's; the owner reads the
 * member's session and the audit log names the read (`logs.owner-read`). Plain fetch and the real CLIs only.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from './proc.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

export interface LogsContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  ok(ran: Promise<{ code: number; out: string }>, what: string): Promise<string>
  admin(...args: string[]): Promise<{ code: number; out: string }>
  tmp: string
  coreUrl: string
  output(): string
}

interface LogSession {
  id: string
  kind: string
  personId: string | null
  calls: number
  primaryModel: string | null
}

const json = { 'content-type': 'application/json' }

/** The owner's own session list: the chat of the owner's TUI, written by the call log after the reply. */
export async function logsOwnerStep(c: LogsContext): Promise<void> {
  await c.step('logs list --json: the owner chat session with the fake provider', async () => {
    let list: LogSession[] = []
    let out = ''
    await until(
      async () => {
        out = (await c.admin('logs', 'list', '--json')).out
        list = (JSON.parse(out) as { sessions: LogSession[] }).sessions
        return list.some((s) => s.id === 'front:owner' && s.calls >= 1)
      },
      15_000,
      'the owner chat session in logs list',
      () => `${c.output().slice(-1500)}\nlogs list:\n${out.slice(0, 1500)}`,
    )
    const mine = list.find((s) => s.id === 'front:owner')
    assert(mine?.kind === 'chat', `owner session kind is ${mine?.kind}, expected chat`)
    assert(mine.primaryModel !== null, 'owner session has no primary model')
    assert(mine.calls >= 1, `owner session has ${mine.calls} calls`)
  })
}

/** The member part: ana's own sessions, the owner's session refused, the owner's audited read of ana's session. */
export async function logsMemberSteps(c: LogsContext): Promise<void> {
  const clientFile = join(c.tmp, 'ana-client.json')
  const rpc = (credential: string, path: string, input: unknown) =>
    fetch(`${c.coreUrl}/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, ...json },
      body: JSON.stringify({ json: input }),
    })
  const ana = (JSON.parse(readFileSync(clientFile, 'utf8')) as { token?: string }).token ?? ''
  assert(ana.startsWith('keith_s_'), 'ana-client.json has no keith_s_ credential')
  const me = (await (await rpc(ana, 'auth/whoami', null)).json()) as { json: { personId: string } }
  const anaId = me.json.personId

  await c.step(
    'logs.sessions: a member sees only their own, the owner session is NOT_FOUND',
    async () => {
      let sessions: LogSession[] = []
      await until(
        async () => {
          const res = await rpc(ana, 'logs/sessions', {})
          assert(res.ok, `logs.sessions for ana answered ${res.status}`)
          sessions = ((await res.json()) as { json: { sessions: LogSession[] } }).json.sessions
          return sessions.some((s) => s.id === `front:${anaId}`)
        },
        15_000,
        "ana's chat session in logs.sessions",
        c.output,
      )
      assert(
        sessions.every((s) => s.personId === anaId),
        `ana sees another person's session: ${JSON.stringify(sessions)}`,
      )
      assert(!sessions.some((s) => s.id === 'front:owner'), 'ana lists the owner session')
      const refused = await rpc(ana, 'logs/session', { id: 'front:owner' })
      assert(!refused.ok, `ana reads the owner session, answered ${refused.status}`)
      assert((await refused.text()).includes('NOT_FOUND'), 'owner session refusal is not NOT_FOUND')
    },
  )

  await c.step('logs show of ana by the owner: the audit log names logs.owner-read', async () => {
    const id = `front:${anaId}`
    const shown = await c.ok(c.admin('logs', 'show', id), 'logs show')
    assert(shown.includes(id), `logs show does not name ${id}:\n${shown}`)
    const audit = await c.ok(c.admin('audit', '--limit', '200'), 'audit')
    assert(audit.includes('logs.owner-read'), `audit does not list logs.owner-read:\n${audit}`)
  })
}

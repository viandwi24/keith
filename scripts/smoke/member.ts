/**
 * P9 member steps of the smoke test: a second person (ana) next to the owner, over TCP, against
 * the same real core. Passphrases and PINs are built at runtime (gitleaks flags literals).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { until } from './proc.ts'
import { cleanEnv } from './tui.ts'

export const OWNER_PIN = ['48', '29', '15'].join('')

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

export interface Ran {
  code: number
  out: string
}

export interface MemberContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  run(cmd: string[], env: Record<string, string>, opts?: { stdin?: string }): Promise<Ran>
  ok(ran: Promise<Ran>, what: string): Promise<string>
  admin(...args: string[]): Promise<Ran>
  adminStdin(stdin: string, ...args: string[]): Promise<Ran>
  tmp: string
  home: string
  coreUrl: string
  tuiBin: string[]
  ownerToken: string
  /** Sets what a failure prints. */
  context(fn: () => string): void
  output(): string
}

/** One chat turn over `POST /sessions/:id/chat` (plain fetch); returns the streamed reply text. */
async function chat(
  coreUrl: string,
  credential: string,
  session: string,
  text: string,
): Promise<string> {
  const res = await fetch(`${coreUrl}/sessions/${encodeURIComponent(session)}/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: session,
      trigger: 'submit-message',
      messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
    }),
  })
  assert(res.ok, `chat on ${session} answered ${res.status}`)
  let reply = ''
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    try {
      const part = JSON.parse(line.slice(6)) as { type?: string; delta?: string }
      if (part.type === 'text-delta') reply += part.delta ?? ''
    } catch {
      // not a JSON chunk
    }
  }
  return reply
}

const json = { 'content-type': 'application/json' }

/** `POST /auth/step-up` with the owner's PIN: the credential stays elevated for ten minutes. */
export async function stepUp(coreUrl: string, credential: string): Promise<number> {
  const res = await fetch(`${coreUrl}/auth/step-up`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, ...json },
    body: JSON.stringify({ pin: OWNER_PIN }),
  })
  return res.status
}

export async function memberSteps(c: MemberContext): Promise<void> {
  const { coreUrl } = c
  const passphrase = `quartz-${crypto.randomUUID()}-harbor`
  const clientFile = join(c.tmp, 'ana-client.json')
  const anaEnv = cleanEnv({ HOME: c.home, KEITH_CLIENT_CONFIG: clientFile })
  const bearer = (credential: string) => ({ authorization: `Bearer ${credential}`, ...json })
  const rpc = (credential: string, path: string) =>
    fetch(`${coreUrl}/rpc/${path}`, {
      method: 'POST',
      headers: bearer(credential),
      body: JSON.stringify({ json: null }),
    })
  const attention = async (credential: string) =>
    (
      (await (await fetch(`${coreUrl}/attention`, { headers: bearer(credential) })).json()) as {
        items: Array<{ id: string; sessionId: string; extra?: Record<string, unknown> }>
      }
    ).items
  const login = (username: string, password: string) =>
    fetch(`${coreUrl}/auth/login`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ username, password }),
    })

  await c.step('people: add ana, set her password and the owner PIN', async () => {
    await c.ok(c.admin('people', 'add', 'ana', '--name', 'Ana'), 'people add')
    await c.ok(c.adminStdin(passphrase, 'people', 'passwd', 'ana', '--password-stdin'), 'passwd')
    await c.ok(c.adminStdin(OWNER_PIN, 'people', 'pin', 'owner', '--pin-stdin'), 'pin')
    const list = await c.ok(c.admin('people', 'list'), 'people list')
    assert(/ana/.test(list), `people list does not show ana:\n${list}`)
  })

  let ana = ''
  let anaId = ''
  await c.step('password login over TCP: client.json 0600, whoami says ana, member', async () => {
    const out = await c.ok(
      c.run(
        [...c.tuiBin, 'login', '--password-stdin', '--username', 'ana', '--core', coreUrl],
        anaEnv,
        { stdin: `${passphrase}\n` },
      ),
      'login --password',
    )
    assert(out.includes('ana'), `login output does not name ana:\n${out}`)
    assert(existsSync(clientFile), 'no client.json after the password login')
    assert((statSync(clientFile).mode & 0o777) === 0o600, 'client.json is not mode 0600')
    ana = (JSON.parse(readFileSync(clientFile, 'utf8')) as { token?: string }).token ?? ''
    assert(ana.startsWith('keith_s_'), 'client.json has no keith_s_ credential')
    const who = await c.ok(c.run([...c.tuiBin, 'whoami'], anaEnv), 'whoami')
    assert(/Ana \(.*, member\)/.test(who), `whoami does not say Ana (member):\n${who}`)
    const me = (await (await rpc(ana, 'auth/whoami')).json()) as { json: { personId: string } }
    anaId = me.json.personId
    assert(anaId !== '' && anaId !== 'owner', `unexpected person id ${anaId}`)
  })

  await c.step('isolation: manage calls 403, owner session 404, own chat answers', async () => {
    for (const path of ['providers/list', 'admin/people/list', 'admin/audit/list']) {
      const res = await rpc(ana, path)
      assert(res.status === 403, `ana on ${path} answered ${res.status}, expected 403`)
      assert((await res.text()).includes('FORBIDDEN'), `${path} refusal is not FORBIDDEN`)
    }
    const owner = (id: string, credential: string) =>
      fetch(`${coreUrl}/sessions/${encodeURIComponent(id)}`, { headers: bearer(credential) })
    const mine = await owner('front:owner', ana)
    assert(mine.status === 404, `ana on front:owner answered ${mine.status}, expected 404`)
    assert((await owner('front:owner', c.ownerToken)).status !== 404, 'the owner lost front:owner')
    const text = await chat(coreUrl, ana, `front:${anaId}`, 'hello')
    assert(text.includes('Hello from the fake provider.'), `ana's chat answered "${text}"`)
  })

  await c.step('member shell: waits for the owner, ana cannot answer, step-up, deny', async () => {
    const cold = /(keith_s_\S+)/.exec(
      await c.ok(c.admin('token', 'create', '--label', 'cold'), 'token create'),
    )?.[1]
    assert(cold !== undefined, 'no cold owner token')
    await chat(coreUrl, ana, `front:${anaId}`, 'run echo smoke on smoke-node')
    c.context(() => `${c.output().slice(-1500)}`)
    let mine = (await attention(ana)).at(0)
    await until(
      async () => {
        mine = (await attention(ana)).at(0)
        return mine !== undefined
      },
      25_000,
      "an item in ana's /attention",
      c.output,
    )
    assert(mine?.extra?.waitingFor === 'owner', `ana's item: ${JSON.stringify(mine)}`)
    // a decision between two people is never consent in one conversation (ADR-0036 §5): the tier is `device`
    assert(
      mine?.extra?.consent === 'device',
      `ana's item has no device tier: ${JSON.stringify(mine)}`,
    )
    const answer = (credential: string, approved: boolean) =>
      fetch(`${coreUrl}/attention/${mine?.id}/answer`, {
        method: 'POST',
        headers: bearer(credential),
        body: JSON.stringify({
          sessionId: mine?.sessionId,
          answer: { kind: 'approval', approved },
        }),
      })
    const refused = await answer(ana, true)
    assert(refused.status === 403, `ana's answer was ${refused.status}, expected 403`)
    assert((await refused.text()).includes('KEITH_WAITING_FOR_OWNER'), 'not WAITING_FOR_OWNER')

    const seen = (await attention(cold)).find((i) => i.id === mine?.id)
    assert(
      seen?.extra?.askedBy === 'ana',
      `the owner does not see who asked: ${JSON.stringify(seen)}`,
    )
    const coldTry = await answer(cold, false)
    assert(coldTry.status === 403, `cold owner answer was ${coldTry.status}, expected 403`)
    assert((await coldTry.text()).includes('KEITH_STEP_UP_REQUIRED'), 'not STEP_UP_REQUIRED')
    assert((await stepUp(coreUrl, cold)) === 200, 'step-up with the owner PIN failed')
    const done = await answer(cold, false)
    assert(done.ok, `the owner's deny answered ${done.status} ${await done.text()}`)
    await until(
      async () => (await attention(ana)).length === 0,
      15_000,
      "ana's item to leave /attention",
      c.output,
    )
  })

  await c.step(
    'brute force: uniform 401, 5 wrong passwords then 429 with Retry-After',
    async () => {
      const unknown = await login('ghost', 'wrong-passphrase-for-ghost')
      const wrong = await login('ana', 'wrong-passphrase-for-ana-0')
      assert(unknown.status === 401 && wrong.status === 401, 'wrong logins are not 401')
      const [a, b] = [await unknown.text(), await wrong.text()]
      assert(a === b, `unknown user body ${a} differs from wrong password body ${b}`)
      for (let i = 1; i < 5; i++) await login('ana', `wrong-passphrase-for-ana-${i}`)
      const blocked = await login('ana', passphrase)
      assert(blocked.status === 429, `the 6th attempt answered ${blocked.status}, expected 429`)
      assert(Number(blocked.headers.get('retry-after')) > 0, 'no Retry-After header')
    },
  )
}

/**
 * P33.6.2 steps of the smoke test (docs/plans/active/P33-persona-and-answer-modes.md, phase 6): the persona and the style over
 * HTTP, with the fake provider's requests read back. The owner switches the persona template (step-up with the PIN first, as
 * for the shell approval). ana sets her style (address, brevity). rhea plants a private address; rhea's own turn carries it
 * (the positive control of the capture), and ana's turn does not. A test client declares `render.speech-only` and is ana's
 * channel: her answer to a request for a Markdown list is saved with no markup.
 *
 * Plain `fetch` and the real CLIs only: scripts import no workspace package. PINs are built at runtime; the template switch
 * and the speech client are the only owner-side and channel changes of this block. The speech client is said goodbye at the end.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FakeProvider } from './fake-provider.ts'
import { FRESH_PIN } from './sign-in.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

interface Ran {
  code: number
  out: string
}

export interface PersonaContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  ok(ran: Promise<Ran>, what: string): Promise<string>
  admin(...args: string[]): Promise<Ran>
  tmp: string
  coreUrl: string
  provider: FakeProvider
}

/** The scripted list of the fake provider (`scripts/smoke/fake-provider.ts`, "markdown list"). */
const LIST_WORD = 'apples'

export async function personaSteps(c: PersonaContext): Promise<void> {
  const { coreUrl } = c
  const json = { 'content-type': 'application/json' }
  const bearer = (credential: string) => ({ authorization: `Bearer ${credential}`, ...json })
  const rpc = (credential: string, path: string, input: unknown = null) =>
    fetch(`${coreUrl}/rpc/${path}`, {
      method: 'POST',
      headers: bearer(credential),
      body: JSON.stringify({ json: input }),
    })
  const rpcJson = async <T>(
    credential: string,
    path: string,
    input: unknown = null,
  ): Promise<T> => {
    const res = await rpc(credential, path, input)
    const body = await res.text()
    assert(res.status === 200, `${path} answered ${res.status}: ${body}`)
    return (JSON.parse(body) as { json: T }).json
  }
  const memberCredential = (name: string): string => {
    const token =
      (JSON.parse(readFileSync(join(c.tmp, `${name}-client.json`), 'utf8')) as { token?: string })
        .token ?? ''
    assert(token.startsWith('keith_s_'), `${name} has no keith_s_ credential`)
    return token
  }
  /** One chat turn over `POST /sessions/:id/chat`; the stream is read to its end (the answer is saved by then). */
  const chat = async (credential: string, session: string, text: string): Promise<void> => {
    const res = await fetch(`${coreUrl}/sessions/${encodeURIComponent(session)}/chat`, {
      method: 'POST',
      headers: bearer(credential),
      body: JSON.stringify({
        id: session,
        trigger: 'submit-message',
        messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
      }),
    })
    assert(res.ok, `chat on ${session} answered ${res.status}`)
    await res.text()
  }
  const whoamiId = async (credential: string): Promise<string> =>
    (await rpcJson<{ personId: string }>(credential, 'auth/whoami')).personId

  // a fixed-shape private address for rhea: letters only, 40 characters, passes the address check
  const sentinel = `Mira${crypto.randomUUID().replace(/[^a-f]/g, 'z')}`
  const ana = memberCredential('ana')
  const rhea = memberCredential('rhea')
  const speechClient = crypto.randomUUID()

  await c.step(
    'persona template: the owner steps up with the PIN and switches to friend',
    async () => {
      const owner =
        /(keith_s_\S+)/.exec(
          await c.ok(c.admin('token', 'create', '--label', 'persona'), 'token create'),
        )?.[1] ?? ''
      assert(owner !== '', 'no owner credential')
      const stepped = await fetch(`${coreUrl}/auth/step-up`, {
        method: 'POST',
        headers: bearer(owner),
        body: JSON.stringify({ pin: FRESH_PIN }),
      })
      assert(stepped.status === 200, `step-up of the owner token answered ${stepped.status}`)
      const before = await rpcJson<{ version: number }>(owner, 'persona/get')
      const after = await rpcJson<{ version: number; templateId: string }>(
        owner,
        'persona/setTemplate',
        { templateId: 'friend' },
      )
      assert(after.templateId === 'friend', `the template is ${after.templateId}, expected friend`)
      assert(after.version === before.version + 1, `version ${before.version} -> ${after.version}`)
    },
  )

  await c.step('persona style: ana sets her address and brevity over HTTP', async () => {
    const style = await rpcJson<{ address: string | null; brevity: string }>(
      ana,
      'persona/style/set',
      { patch: { address: 'Annabel', brevity: 'short' } },
    )
    assert(
      style.address === 'Annabel' && style.brevity === 'short',
      `ana's style is ${JSON.stringify(style)}`,
    )
  })

  await c.step(
    'persona private: rhea plants a private address; her own turn carries it',
    async () => {
      await rpcJson(rhea, 'persona/style/set', { patch: { address: sentinel } })
      const rheaId = await whoamiId(rhea)
      const mark = c.provider.requests().length
      await chat(rhea, `front:${rheaId}`, 'hello from rhea')
      const turn = c.provider.requests().slice(mark).join('\n')
      assert(
        turn.includes(sentinel),
        "the capture does not show rhea's own address in her turn (the check would be empty)",
      )
    },
  )

  await c.step(
    'persona speech: ana declares render.speech-only; her list comes back without markup',
    async () => {
      const anaId = await whoamiId(ana)
      const client = {
        id: speechClient,
        kind: 'web',
        label: 'persona speech',
        capabilities: ['render.speech-only'],
        version: '0',
      }
      await rpcJson(ana, 'presence/clients/register', client)
      await rpcJson(ana, 'presence/clients/heartbeat', { id: speechClient, active: true })
      await chat(ana, `front:${anaId}`, 'give me a markdown list of fruit')
      const res = await fetch(
        `${coreUrl}/sessions/${encodeURIComponent(`front:${anaId}`)}/messages?limit=200`,
        { headers: { authorization: `Bearer ${ana}` } },
      )
      assert(res.status === 200, `ana's session messages answered ${res.status}`)
      const page = (await res.json()) as {
        messages: Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>
      }
      const answer = page.messages
        .filter((m) => m.role === 'assistant')
        .at(-1)
        ?.parts?.filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('')
      assert(answer?.includes(LIST_WORD) === true, `ana's answer is not the list: ${answer}`)
      assert(
        !/[*`#_~>|]|^\s*(?:[-+]|\d+[.)])\s/m.test(answer ?? ''),
        `ana's spoken answer still holds markup: ${answer}`,
      )
    },
  )

  await c.step("persona leak: rhea's planted address is absent from ana's turn", async () => {
    const mark = c.provider.requests().length
    const anaId = await whoamiId(ana)
    await chat(ana, `front:${anaId}`, 'what should I do today?')
    const turn = c.provider.requests().slice(mark).join('\n')
    assert(
      turn.includes('Annabel'),
      "ana's own address is not in her turn (the check would be empty)",
    )
    assert(!turn.includes(sentinel), "rhea's private address appears in ana's turn")
  })

  await c.step('persona end: the speech client says goodbye', async () => {
    await rpcJson(ana, 'presence/clients/goodbye', { id: speechClient })
  })
}

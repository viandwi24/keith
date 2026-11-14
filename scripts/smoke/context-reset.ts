/**
 * P34.3.3 steps of the smoke test (docs/specs/chat-context.md "Tests", ADR-0030): the context reset over RPC against the
 * running core, with the fake provider's requests read back. ana has a chat turn; `chat/newContext` starts her next
 * generation (the flush runs first, as the default); her old generation stays readable through `chat/history`; her next
 * turn goes to the new generation, and its request holds none of the old text; the old id answers 404. rhea's generations
 * and transcript do not change. The audit list shows `chat.context.new` and no text of the old context.
 *
 * Plain `fetch` and the real CLIs only: scripts import no workspace package. ana and rhea are members of the earlier
 * blocks (their credentials are in their client files).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FakeProvider } from './fake-provider.ts'

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

interface Ran {
  code: number
  out: string
}

export interface ContextResetContext {
  step(name: string, fn: () => Promise<void>): Promise<void>
  ok(ran: Promise<Ran>, what: string): Promise<string>
  admin(...args: string[]): Promise<Ran>
  tmp: string
  coreUrl: string
  provider: FakeProvider
}

/** The text ana wrote before the reset: it must be in the old generation and absent from the new one. */
const OLD_LINE = 'context-reset keep this line about the garden'

export async function contextResetSteps(c: ContextResetContext): Promise<void> {
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
  const chatTo = async (credential: string, session: string, text: string): Promise<number> => {
    const res = await fetch(`${coreUrl}/sessions/${encodeURIComponent(session)}/chat`, {
      method: 'POST',
      headers: bearer(credential),
      body: JSON.stringify({
        id: session,
        trigger: 'submit-message',
        messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
      }),
    })
    await res.text()
    return res.status
  }
  const chat = async (credential: string, session: string, text: string): Promise<void> => {
    const status = await chatTo(credential, session, text)
    assert(status === 200, `chat on ${session} answered ${status}`)
  }
  const whoamiId = async (credential: string): Promise<string> =>
    (await rpcJson<{ personId: string }>(credential, 'auth/whoami')).personId
  type Generation = { generation: number; startedAt: number; messages: number }
  type HistoryLine = { seq: number; role: string; text: string; at: number }

  const ana = memberCredential('ana')
  const rhea = memberCredential('rhea')
  const anaId = await whoamiId(ana)
  // a snapshot of rhea before ana's reset: her generations and her transcript must read the same afterwards
  const rheaBefore = JSON.stringify(await rpcJson<Generation[]>(rhea, 'chat/generations'))
  const rheaHistoryBefore = JSON.stringify(
    await rpcJson<HistoryLine[]>(rhea, 'chat/history', { generation: 0 }),
  )

  let oldGeneration = -1
  let newGeneration = -1

  await c.step(
    'context-reset reset: ana has a turn, then chat/newContext starts her next generation',
    async () => {
      await chat(ana, `front:${anaId}`, OLD_LINE)
      const before = await rpcJson<Generation[]>(ana, 'chat/generations')
      oldGeneration = Math.max(...before.map((g) => g.generation))
      const done = await rpcJson<{ generation: number; flushed: boolean }>(ana, 'chat/newContext', {
        flush: true,
      })
      assert(
        done.generation === oldGeneration + 1,
        `the generation is ${done.generation}, expected ${oldGeneration + 1}`,
      )
      newGeneration = done.generation
    },
  )

  await c.step(
    'context-reset history: the old generation is readable through chat/history',
    async () => {
      const lines = await rpcJson<HistoryLine[]>(ana, 'chat/history', { generation: oldGeneration })
      assert(
        lines.some((l) => l.role === 'user' && l.text === OLD_LINE),
        `the old generation ${oldGeneration} does not hold the line: ${JSON.stringify(lines).slice(0, 300)}`,
      )
      const generations = await rpcJson<Generation[]>(ana, 'chat/generations')
      assert(
        generations.some((g) => g.generation === newGeneration),
        `chat/generations does not list generation ${newGeneration}`,
      )
    },
  )

  await c.step(
    'context-reset next turn: the new generation answers with none of the old text',
    async () => {
      const oldStatus = await chatTo(ana, `front:${anaId}`, 'context-reset on the old id')
      assert(oldStatus === 404, `the old id answered ${oldStatus}, expected 404`)
      const mark = c.provider.requests().length
      await chat(ana, `front:${anaId}:g${newGeneration}`, 'context-reset what did we talk about?')
      const turn = c.provider.requests().slice(mark).join('\n')
      assert(
        turn.includes('context-reset what did we talk about?'),
        'the new turn is not in its request (empty check)',
      )
      assert(!turn.includes(OLD_LINE), 'the old line reached the request of the new generation')
    },
  )

  await c.step(
    "context-reset isolation: rhea's generations and transcript are unchanged",
    async () => {
      const after = JSON.stringify(await rpcJson<Generation[]>(rhea, 'chat/generations'))
      const afterHistory = JSON.stringify(
        await rpcJson<HistoryLine[]>(rhea, 'chat/history', { generation: 0 }),
      )
      assert(after === rheaBefore, "rhea's generations changed after ana's reset")
      assert(afterHistory === rheaHistoryBefore, "rhea's transcript changed after ana's reset")
    },
  )

  await c.step('context-reset audit: chat.context.new is listed and holds no text', async () => {
    const out = await c.ok(c.admin('audit', '--limit', '200'), 'audit')
    assert(out.includes('chat.context.new'), `audit does not list chat.context.new:\n${out}`)
    assert(
      !out.includes(OLD_LINE) && !out.includes('garden'),
      'the audit list holds text of the old context',
    )
  })
}

// Phase 5 integration helpers (P5-I1): people signed up through real invite links, one node each,
// frames matched by content, and a chat fake that answers by what a request holds (turns of
// different people run concurrently, so a fixed script order would be flaky).

import type { LoginResponse } from '@keith/protocol'
import type { LlmRequest } from '@keith/sdk'
import {
  createFakeLlm,
  createFakeLlmPlugin,
  type FakeClock,
  type FakeLlm,
  type FakeLlmStep,
  fakeText,
} from '@keith/sdk/testing'
import { bootstrap, type Keith } from '../src/bootstrap.ts'
import { addPersonForTest } from '../src/cli/person-testing.ts'
import { connect, type ReceivedFrame, type TestClient } from '../src/server/test-fakes.ts'
import type { PersonId, ThreadId, Tier } from '../src/shared/types.ts'
import {
  createOwner,
  createSplitFake,
  createTestHome,
  login,
  quietLogger,
  type SplitFake,
  splitModelConfig,
  type TestHome,
  testClock,
  wsUrl,
} from './helpers.ts'

export type Cleanups = (() => Promise<void> | void)[]

/** One scripted answer: used for the first request `when` matches, `times` times (default 1). */
export type Route = {
  name: string
  when: (req: LlmRequest) => boolean
  reply: (req: LlmRequest) => FakeLlmStep[]
  times?: number
}

export type RoutedChat = FakeLlm & {
  /** Adds routes (checked in the order added). */
  route(...routes: Route[]): void
  /** Requests no route matched (they got the text "(unscripted)"). */
  readonly unmatched: LlmRequest[]
  /** Names of the routes used, in order. */
  readonly used: string[]
}

export function routedChat(): RoutedChat {
  const routes: (Route & { left: number })[] = []
  const unmatched: LlmRequest[] = []
  const used: string[] = []
  const fake = createFakeLlm([], {
    fallback: (req) => {
      const found = routes.find((r) => r.left > 0 && r.when(req))
      if (!found) {
        unmatched.push(req)
        return fakeText('(unscripted)')
      }
      found.left -= 1
      used.push(found.name)
      return found.reply(req)
    },
  })
  return Object.assign(fake, {
    route(...more: Route[]) {
      for (const r of more) routes.push({ ...r, left: r.times ?? 1 })
    },
    unmatched,
    used,
  })
}

/** The last message's content when it is a user message (a new user step), else null. */
export function lastUser(req: LlmRequest): string | null {
  const last = req.messages.at(-1)
  return last?.role === 'user' ? last.content : null
}

/** Whether the last message is the result of a call to `tool` (the step after a tool call). */
export function afterTool(req: LlmRequest, tool: string): boolean {
  const last = req.messages.at(-1)
  if (last?.role !== 'tool') return false
  const call = [...req.messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === last.toolCallId))
  return call?.role === 'assistant' && call.toolCalls?.some((c) => c.name === tool) === true
}

/** The result text of the last tool call (the step after it). */
export function toolResult(req: LlmRequest): string {
  const last = req.messages.at(-1)
  return last?.role === 'tool' ? last.content : ''
}

export type World = {
  home: TestHome
  clock: FakeClock
  owner: PersonId
  fake: SplitFake & { chat: RoutedChat }
}

/** A KEITH_HOME with the owner (Tony) and the split fake models. `extra` is more TOML. */
export async function createWorld(cleanups: Cleanups, extra = ''): Promise<World> {
  const home = await createTestHome(splitModelConfig(extra))
  cleanups.push(() => home.remove())
  const clock = testClock()
  const owner = await createOwner(home.dir, clock)
  const chat = routedChat()
  // Greetings end a person's arrival hold (mind.arrival.briefing = "on-greeting").
  chat.route({
    name: 'greeting',
    when: (r) => lastUser(r) === 'Hi.',
    reply: () => fakeText('Hello.'),
    times: 1000,
  })
  const fake = createSplitFake(chat) as SplitFake & { chat: RoutedChat }
  return { home, clock, owner, fake }
}

export async function startKeith(world: World, cleanups: Cleanups): Promise<Keith> {
  const keith = await bootstrap({
    home: world.home.dir,
    env: {},
    plugins: [createFakeLlmPlugin(world.fake)],
    clock: world.clock,
    log: quietLogger(world.clock),
  })
  cleanups.push(() => keith.stop())
  return keith
}

/** `POST /v1/auth/invite`. Returns the response (status and body). */
export async function acceptInvite(
  url: string,
  body: { code: string; username: string; password: string },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}/v1/auth/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

/** The invite code in a printed link (`<publicUrl>/#invite=<code>`). */
export function codeFromLink(text: string): string {
  const match = /#invite=([A-Za-z0-9_-]+)/.exec(text)
  if (!match?.[1]) throw new Error(`no invite link in: ${text}`)
  return match[1]
}

export type Member = {
  id: PersonId
  name: string
  token: string
  client: TestClient
  main: ThreadId
}

/** A node for `token` with the person's main thread open. */
export async function attach(
  keith: Keith,
  token: string,
  cleanups: Cleanups,
): Promise<{ client: TestClient; main: ThreadId }> {
  const client = await connect(wsUrl(keith.url, token))
  cleanups.push(() => client.close())
  await client.hello()
  const id = client.send('thread.open', {})
  const opened = await waitFrame(client, 'thread.opened', (f) => f.re === id)
  return { client, main: (opened.data.thread as { id: ThreadId }).id }
}

/** Tony, the owner, on one node. */
export async function attachOwner(keith: Keith, world: World, cleanups: Cleanups): Promise<Member> {
  const token = await login(keith.url)
  const { client, main } = await attach(keith, token, cleanups)
  return { id: world.owner, name: 'Tony', token, client, main }
}

/**
 * Adds a person the way `keith person add` does (the real database, while Keith runs), signs them
 * up through `POST /v1/auth/invite` with the printed code, and attaches one node.
 */
export async function signUp(
  keith: Keith,
  world: World,
  cleanups: Cleanups,
  name: string,
  tier: Exclude<Tier, 'owner'> = 'member',
): Promise<Member> {
  const { person, invite } = await addPersonForTest(world.home.dir, { name, tier }, world.clock)
  const res = await acceptInvite(keith.url, {
    code: invite.code,
    username: name.toLowerCase(),
    password: `${name.toLowerCase()}-password`,
  })
  if (res.status !== 200) throw new Error(`invite failed: ${res.status} ${JSON.stringify(res.body)}`)
  const token = (res.body as LoginResponse).token
  const { client, main } = await attach(keith, token, cleanups)
  return { id: person.id, name, token, client, main }
}

const consumed = new WeakMap<TestClient, Set<ReceivedFrame>>()

/** The next frame of `type` matching `match` that no earlier `waitFrame` returned. */
export async function waitFrame(
  client: TestClient,
  type: string,
  match: (frame: ReceivedFrame) => boolean = () => true,
  timeoutMs = 3_000,
): Promise<ReceivedFrame> {
  let taken = consumed.get(client)
  if (!taken) {
    taken = new Set()
    consumed.set(client, taken)
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = client.frames.find((f) => f.type === type && !taken.has(f) && match(f))
    if (found) {
      taken.add(found)
      return found
    }
    if (Date.now() > deadline) {
      const seen = client.frames.map((f) => f.type).join(', ')
      throw new Error(`no matching '${type}' frame within ${timeoutMs} ms (seen: ${seen})`)
    }
    await Bun.sleep(5)
  }
}

/** Frames of `type` for `threadId` (`data.threadId`, or `data.thread.id`). */
export function framesFor(client: TestClient, type: string, threadId: ThreadId): ReceivedFrame[] {
  return client.frames.filter((f) => f.type === type && frameThread(f) === threadId)
}

export function frameThread(f: ReceivedFrame): string | undefined {
  const data = f.data as { threadId?: string; thread?: { id?: string }; message?: { threadId?: string } }
  return data.threadId ?? data.thread?.id ?? data.message?.threadId
}

/**
 * Says "Hi." in the person's main thread and waits for the answer. A first open is an arrival,
 * which holds deliveries until the first input (or `mind.arrival.holdMs`).
 */
export async function greet(keith: Keith, member: Member): Promise<void> {
  say(member, member.main, 'Hi.')
  await waitFrame(member.client, 'message.completed', (f) => frameThread(f) === member.main)
  await settle(keith)
}

/** Sends text into a thread. */
export function say(member: Member, threadId: ThreadId, text: string): string {
  return member.client.send('input.text', { threadId, text })
}

/** Waits until every turn and event handler is done. */
export async function settle(keith: Keith): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await keith.threads.idle()
    await keith.events.idle()
    await Bun.sleep(10)
  }
}

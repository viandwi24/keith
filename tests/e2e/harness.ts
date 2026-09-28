// End-to-end harness: boots the real core in-process (real SQLite, scheduler, server, mind) with a
// scripted fake LLM, and talks to it the way a node does: HTTP login, then the WebSocket protocol.
//
// `tests/e2e` is not a workspace package, so with Bun's isolated linker it cannot resolve
// `@keith/*` by name. It imports the packages' entry files by relative path instead (check-deps
// allows any import from `tests/e2e`). Symlinks resolve to the same files, so these are the same
// module instances the core itself uses.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addPersonForTest } from '../../packages/core/src/cli/person-testing.ts'
import { bootstrap, type Keith } from '../../packages/core/src/index.ts'
import {
  type CoreFrame,
  type CoreFrameType,
  type FrameData,
  LoginResponse,
  type MessageDto,
  makeFrame,
  type NodeFrameType,
  PersonId,
  parseCoreFrame,
  type ThreadId,
  type Tier,
} from '../../packages/protocol/src/index.ts'
import {
  type AnyPluginDefinition,
  type Clock,
  type EventMap,
  type EventName,
  type LlmEvent,
  type LlmProvider,
  type LlmRequest,
  type Logger,
  ProviderError,
} from '../../packages/sdk/src/index.ts'
import {
  createFakeClock,
  createFakeLlm,
  createFakeLlmPlugin,
  type FakeClock,
  type FakeLlm,
  type FakeLlmStep,
  type FakeLlmTurn,
  fakeText,
} from '../../packages/sdk/src/testing/index.ts'

export type { Keith }

/** Default wait for a frame or a condition. Generous for slow CI boxes; a passing test never waits it out. */
export const WAIT_MS = 5_000

/** Per-test timeout for scenario tests (bun's default of 5 s is shorter than one frame wait). */
export const TEST_TIMEOUT_MS = 20_000

// Config and home

export type E2eConfig = {
  awayAfterMinutes?: number
  briefing?: 'auto' | 'on-greeting' | 'off'
  holdMs?: number
  graceMs?: number
  /** Plugin packages to load by name (dynamic `import()`, as `keith start` does). */
  enabled?: string[]
  /** `mind.timezone` (IANA). Default: the schema's (the system time zone). */
  timezone?: string
  /** `mind.context.recentMessages`. Default: the schema's (40). */
  recentMessages?: number
  /** `[memory.reflect]` and `[memory.summary]`. Default: the schema's. */
  reflect?: { enabled?: boolean; idleMinutes?: number }
  summary?: { enabled?: boolean }
  /** Extra TOML appended to the config (e.g. `[plugins."@keith/web"]` sections). */
  extra?: string
}

function tomlTable(name: string, keys: Record<string, unknown>): string {
  const lines = Object.entries(keys)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
  return lines.length > 0 ? `\n[${name}]\n${lines.join('\n')}\n` : ''
}

/**
 * config.toml for e2e runs. Model roles point at the scripted provider `fake`: `foreground` (turns)
 * at model `chat`, `background` (tasks) at model `researcher`, `utility` (reflection, summaries) at
 * model `utility`. The scheduler tick is long so that `last_seen_at` only moves when a test moves
 * it, and reflection and reminders run only on the ticks a test emits (`tick`). No test before
 * phase 4 reaches a utility call, so their providers need no `utility` model.
 */
export function e2eConfig(c: E2eConfig = {}): string {
  return `
[server]
port = 0

[models]
foreground = "fake:chat"
background = "fake:researcher"
utility    = "fake:utility"
${tomlTable('mind', { timezone: c.timezone })}${tomlTable('mind.context', { recentMessages: c.recentMessages })}
[mind.arrival]
awayAfterMinutes = ${c.awayAfterMinutes ?? 1}
briefing = "${c.briefing ?? 'on-greeting'}"
holdMs = ${c.holdMs ?? 60_000}
graceMs = ${c.graceMs ?? 50}

[scheduler]
tickMs = 3600000
${tomlTable('memory.reflect', { ...c.reflect })}${tomlTable('memory.summary', { ...c.summary })}
[plugins]
enabled  = ${JSON.stringify(c.enabled ?? [])}
required = []
stopTimeoutMs = 500
${c.extra ?? ''}`
}

export type E2eHome = { dir: string; remove(): void }

/** A temp `KEITH_HOME` holding `config.toml`. */
export async function createHome(config = e2eConfig()): Promise<E2eHome> {
  const dir = mkdtempSync(join(tmpdir(), 'keith-e2e-'))
  await Bun.write(join(dir, 'config.toml'), config)
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

// Clock and logger

export function e2eClock(): FakeClock {
  return createFakeClock(1_790_000_000_000)
}

/** Keeps log lines in memory (set KEITH_TEST_LOG=1 to print them). */
export function memoryLogger(clock: Clock, lines: string[] = [], base: Record<string, unknown> = {}): Logger {
  const write = (level: string, msg: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: clock.now(), level, msg, ...base, ...fields })
    lines.push(line)
    if (process.env.KEITH_TEST_LOG === '1') process.stderr.write(`${line}\n`)
  }
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => memoryLogger(clock, lines, { ...base, ...fields }),
  }
}

// Scripted models

/** A promise that tests open by hand, to hold a scripted model at a known point. */
export type Gate = { promise: Promise<void>; open(): void; readonly isOpen: boolean }

export function createGate(): Gate {
  let open = () => {}
  let isOpen = false
  const promise = new Promise<void>((resolve) => {
    open = () => {
      isOpen = true
      resolve()
    }
  })
  return {
    promise,
    open,
    get isOpen() {
      return isOpen
    },
  }
}

/**
 * One scripted model behind the `fake` provider. `before` runs before each call streams (to hold a
 * call at a known point); an abort of the call's signal ends that wait like a provider abort.
 */
export type ScriptedModel = { llm: FakeLlm; before?: (req: LlmRequest) => Promise<void> }

/**
 * An LLM provider with id `fake` that routes each request to a scripted model by `req.model`
 * (`fake:chat` → `models.chat`). Unknown models throw.
 */
export function scriptedProvider(models: Record<string, ScriptedModel>): LlmProvider {
  return {
    id: 'fake',
    async *stream(req, signal): AsyncIterable<LlmEvent> {
      const model = models[req.model]
      if (!model) throw new ProviderError('bad_request', `no scripted model '${req.model}'`)
      if (model.before) await untilAborted(model.before(req), signal)
      yield* model.llm.stream(req, signal)
    },
  }
}

function untilAborted(wait: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new ProviderError('aborted', 'request aborted', { cause: signal.reason }))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    wait.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** A fake LLM that plays `script`, then `fallback` (default: a short reply) for further calls. */
export function scriptedLlm(script: FakeLlmTurn[] = [], fallback?: FakeLlmTurn): FakeLlm {
  return createFakeLlm(script, {
    fallback: fallback ?? [{ type: 'text.delta', text: 'Noted.' }],
  })
}

// The core

export type E2eKeith = { keith: Keith; logLines: string[] }

/** Boots Keith from `home` with the given provider, the fake clock, env `{}` and a memory logger. */
export async function startKeith(opts: {
  home: E2eHome
  provider: LlmProvider
  clock: FakeClock
  plugins?: AnyPluginDefinition[]
}): Promise<E2eKeith> {
  const logLines: string[] = []
  const keith = await bootstrap({
    home: opts.home.dir,
    env: {},
    plugins: [createFakeLlmPlugin(opts.provider), ...(opts.plugins ?? [])],
    clock: opts.clock,
    log: memoryLogger(opts.clock, logLines),
  })
  return { keith, logLines }
}

export type E2ePerson = { id: PersonId; name: string; username: string; password: string }

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A random, well-formed ULID (the core's own ids use the clock; persons here are fixtures). */
function randomUlid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26))
  return [...bytes].map((b, i) => CROCKFORD[i === 0 ? b % 8 : b % 32]).join('')
}

/** Creates a person that can sign in, plus a relationship card when `tone` is given. */
export async function addPerson(
  keith: Keith,
  clock: Clock,
  p: { name: string; tier: Tier; tone?: string },
): Promise<E2ePerson> {
  const id = PersonId.parse(`per_${randomUlid()}`)
  const username = p.name.toLowerCase()
  const password = `${username}-password`
  await keith.repos.persons.create({
    id,
    name: p.name,
    username,
    passwordHash: await Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 4096, timeCost: 1 }),
    tier: p.tier,
    lastSeenAt: null,
    createdAt: clock.now(),
  })
  if (p.tone !== undefined) {
    await keith.repos.relationships.upsert({ personId: id, tone: p.tone, notes: '', blockedRelayFrom: [] })
  }
  return { id, name: p.name, username, password }
}

/** Resolves with the payload of the next event `name` for which `match` holds. */
export function nextEvent<N extends EventName>(
  keith: Keith,
  name: N,
  match: (data: EventMap[N]) => boolean = () => true,
  timeoutMs = WAIT_MS,
): Promise<EventMap[N]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error(`no '${name}' event within ${timeoutMs} ms`))
    }, timeoutMs)
    const off = keith.events.on(name, (e) => {
      if (!match(e.data)) return
      clearTimeout(timer)
      off()
      resolve(e.data)
    })
  })
}

/** One scheduler tick at the fake clock's time, the payload the real timer emits (`tickMs` is an hour here). */
export function tick(keith: Keith, clock: Clock): void {
  keith.events.emit('scheduler.ticked', { at: clock.now() })
}

/** Polls `check` until it holds. */
export async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await Bun.sleep(5)
  }
}

// A protocol-level node

export type FrameOfType<T extends CoreFrameType> = Extract<CoreFrame, { type: T }>

export interface E2eNode {
  /** Every core frame received, in order (validated with `parseCoreFrame`). */
  readonly frames: CoreFrame[]
  /** Every binary (audio) frame received, in order, as raw bytes. */
  readonly binary: Uint8Array[]
  readonly nodeId: string
  /** The next not yet taken frame of `type` that satisfies `match`. */
  next<T extends CoreFrameType>(
    type: T,
    match?: (f: FrameOfType<T>) => boolean,
    timeoutMs?: number,
  ): Promise<FrameOfType<T>>
  send<T extends NodeFrameType>(type: T, data: FrameData<T>): string
  /** `thread.open` without a thread id: the person's main thread. */
  openMain(): Promise<{ threadId: ThreadId; messages: MessageDto[] }>
  /** Sends `input.text`. */
  say(threadId: ThreadId, text: string): string
  /** Waits for the next completed assistant message in the thread. */
  reply(threadId: ThreadId, timeoutMs?: number): Promise<MessageDto>
  close(): Promise<void>
}

export async function login(keith: Keith, person: E2ePerson): Promise<string> {
  const res = await fetch(`${keith.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: person.username, password: person.password }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  const body = (await res.json()) as { token: string }
  return body.token
}

let nodeFrameSeq = 0

/** Signs `person` in, connects a WebSocket, and completes `hello` → `welcome`. */
export async function connectNode(
  keith: Keith,
  person: E2ePerson,
  opts: { token?: string | undefined; capabilities?: string[] | undefined } = {},
): Promise<E2eNode> {
  const token = opts.token ?? (await login(keith, person))
  const url = `${keith.url.replace(/^http/, 'ws')}/v1/ws?token=${encodeURIComponent(token)}`
  const ws = new WebSocket(url)
  const frames: CoreFrame[] = []
  const binary: Uint8Array[] = []
  const taken = new Set<CoreFrame>()
  const waiters = new Set<() => void>()
  const problems: string[] = []

  ws.binaryType = 'arraybuffer'
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') {
      binary.push(new Uint8Array(e.data as ArrayBuffer))
      for (const w of [...waiters]) w()
      return
    }
    const parsed = parseCoreFrame(String(e.data))
    if (!parsed.ok) {
      problems.push(`${parsed.code}: ${parsed.message}`)
    } else {
      frames.push(parsed.frame)
      if (parsed.frame.type === 'ping') ws.send(nodeFrame('pong', {}).text)
    }
    for (const w of [...waiters]) w()
  })
  const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
  })

  /** Builds a node frame; returns its id and its JSON text. */
  function nodeFrame<T extends NodeFrameType>(type: T, data: FrameData<T>): { id: string; text: string } {
    nodeFrameSeq += 1
    const id = `e2e${nodeFrameSeq}`
    return { id, text: JSON.stringify(makeFrame(type, data, { id, ts: Date.now() })) }
  }

  const node: E2eNode = {
    frames,
    binary,
    nodeId: '',
    async next(type, match = () => true, timeoutMs = WAIT_MS) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (problems.length > 0) throw new Error(`invalid core frame: ${problems.join('; ')}`)
        const found = frames.find(
          (f): f is FrameOfType<typeof type> => f.type === type && !taken.has(f) && match(f as never),
        )
        if (found) {
          taken.add(found)
          return found
        }
        const left = deadline - Date.now()
        if (left <= 0) {
          const seen = frames.map((f) => f.type).join(', ')
          throw new Error(`no matching '${type}' frame within ${timeoutMs} ms (received: ${seen})`)
        }
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            waiters.delete(done)
            resolve()
          }
          const timer = setTimeout(done, left)
          waiters.add(done)
        })
      }
    },
    send(type, data) {
      const frame = nodeFrame(type, data)
      ws.send(frame.text)
      return frame.id
    },
    async openMain() {
      node.send('thread.open', {})
      const opened = await node.next('thread.opened')
      return { threadId: opened.data.thread.id, messages: opened.data.messages }
    },
    say(threadId, text) {
      return node.send('input.text', { threadId, text })
    },
    async reply(threadId, timeoutMs = WAIT_MS) {
      const done = await node.next(
        'message.completed',
        (f) => f.data.message.threadId === threadId,
        timeoutMs,
      )
      return done.data.message
    },
    async close() {
      if (ws.readyState !== WebSocket.CLOSED) ws.close()
      await closed
    },
  }

  node.send('hello', {
    protocol: 1,
    client: { name: 'keith-e2e', version: '0.0.0' },
    capabilities: opts.capabilities ?? ['chat.text@1'],
  })
  const welcome = await node.next('welcome')
  Object.assign(node, { nodeId: welcome.data.nodeId })
  return node
}

/** The system prompt text of a request (for "the context includes ..." assertions). */
export function systemOf(req: LlmRequest | undefined): string {
  return req?.system ?? ''
}

/** Every message text of a request, joined. */
export function transcriptOf(req: LlmRequest | undefined): string {
  return (req?.messages ?? []).map((m) => `${m.role}: ${m.content}`).join('\n')
}

// People (phase 5): sign-up through invite links, a routed chat model, request text

/**
 * Adds a person the way `keith person add` does (on the real home, while Keith runs) and signs them
 * up through `POST /v1/auth/invite` with the invite code, as the web app and `keith-tui --invite`
 * do. Returns the person (who can also log in with `password`) and the session token the invite
 * gave. `tone` writes their relationship card.
 */
export async function signUp(
  keith: Keith,
  home: E2eHome,
  clock: Clock,
  p: { name: string; tier?: Exclude<Tier, 'owner'>; tone?: string },
): Promise<E2ePerson & { token: string }> {
  const { person, invite } = await addPersonForTest(
    home.dir,
    { name: p.name, tier: p.tier ?? 'member' },
    clock,
  )
  const username = p.name.toLowerCase()
  const password = `${username}-password`
  const res = await fetch(`${keith.url}/v1/auth/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invite.code, username, password }),
  })
  if (!res.ok) throw new Error(`invite failed: ${res.status} ${await res.text()}`)
  const body = LoginResponse.parse(await res.json())
  if (p.tone !== undefined) {
    await keith.repos.relationships.upsert({
      personId: person.id,
      tone: p.tone,
      notes: '',
      blockedRelayFrom: [],
    })
  }
  return { id: person.id, name: person.name, username, password, token: body.token }
}

export const GREETING = 'Hi.'

/**
 * Says "Hi." in the thread and waits for the answer. A person's first `thread.open` is an arrival,
 * and with `briefing = "on-greeting"` their deliveries wait for their first input.
 */
export async function greet(node: E2eNode, threadId: ThreadId): Promise<MessageDto> {
  node.say(threadId, GREETING)
  return node.reply(threadId)
}

/** Context section 8's heading: the turn carries pending deliveries. */
export const PENDING_ITEMS_HEADING = '# Things to tell them'

/** One scripted answer: used for the first request `when` matches, `times` times (default 1). */
export type Route = {
  name: string
  when: (req: LlmRequest) => boolean
  reply: (req: LlmRequest) => FakeLlmStep[]
  times?: number
}

export type RoutedChat = FakeLlm & {
  /** Adds routes, checked in the order added. */
  route(...routes: Route[]): void
  /** Requests no route matched (they got the text "(unscripted)"). */
  readonly unmatched: LlmRequest[]
  /** Names of the routes used, in order. */
  readonly used: string[]
}

/**
 * A chat model that answers by what a request holds (P5-I1's `routedChat`). Turns of different
 * people run concurrently, so a fixed script order would be flaky. A plain "Hi." with no pending
 * items in its context is answered "Hello.".
 */
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
  const chat: RoutedChat = Object.assign(fake, {
    route(...more: Route[]) {
      for (const r of more) routes.push({ ...r, left: r.times ?? 1 })
    },
    unmatched,
    used,
  })
  chat.route({
    name: 'greeting',
    when: (r) => lastUser(r) === GREETING && !systemOf(r).includes(PENDING_ITEMS_HEADING),
    reply: () => fakeText('Hello.'),
    times: 1000,
  })
  return chat
}

/** The last message's content when it is a user message (a new user step), else null. */
export function lastUser(req: LlmRequest): string | null {
  const last = req.messages.at(-1)
  return last?.role === 'user' ? last.content : null
}

/** Whether the last message is the result of a call to `tool` (the step after that call). */
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

/** Everything a model saw in a request: the system prompt, every message and every tool call's arguments. */
export function requestText(req: LlmRequest): string {
  const parts = [systemOf(req)]
  for (const m of req.messages) {
    parts.push(m.content)
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) parts.push(JSON.stringify(c.args))
  }
  return parts.join('\n')
}

/** The lines of context section 6 (the awareness digest), without its heading. Empty when absent. */
export function digestOf(req: LlmRequest | undefined): string[] {
  const lines = systemOf(req).split('\n')
  const start = lines.indexOf('# Meanwhile')
  if (start < 0) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break
    out.push(line)
  }
  return out
}

/** Waits until every turn and event handler is done. */
export async function settle(keith: Keith): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await keith.threads.idle()
    await keith.events.idle()
    await Bun.sleep(10)
  }
}

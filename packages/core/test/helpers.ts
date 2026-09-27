// Shared helpers for the bootstrap and CLI tests: a temp KEITH_HOME with a fake-LLM config, the
// owner account, login and a quiet logger.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreEventMap, LlmProvider, Logger } from '@keith/sdk'
import { createFakeClock, createFakeLlm, type FakeClock, type FakeLlm } from '@keith/sdk/testing'
import type { CoreEventBus } from '../src/events/types.ts'
import { createIds, createLogger } from '../src/shared/index.ts'
import type { PersonId } from '../src/shared/types.ts'
import { openDb } from '../src/storage/index.ts'

export const OWNER = { name: 'Tony', username: 'tony', password: 'correct horse' } as const

/** Config for tests: every role on the fake provider, no configured plugins, fast ticks off. */
export const FAKE_CONFIG = `
[server]
port = 0

[models]
foreground = "fake:scripted"
background = "fake:scripted"
utility    = "fake:scripted"

[plugins]
enabled  = []
required = []
stopTimeoutMs = 500
`

export type TestHome = { dir: string; [Symbol.dispose](): void; remove(): void }

/** A temp KEITH_HOME holding `config` as config.toml. */
export async function createTestHome(config = FAKE_CONFIG): Promise<TestHome> {
  const dir = mkdtempSync(join(tmpdir(), 'keith-home-'))
  await Bun.write(join(dir, 'config.toml'), config)
  const remove = () => rmSync(dir, { recursive: true, force: true })
  return { dir, remove, [Symbol.dispose]: remove }
}

/** Creates the owner person directly in the home's database (what `keith setup` does). */
export async function createOwner(home: string, clock: FakeClock): Promise<PersonId> {
  const db = openDb(join(home, 'keith.db'))
  try {
    const id = createIds({ clock }).next('per')
    await db.repos.persons.create({
      id,
      name: OWNER.name,
      username: OWNER.username,
      passwordHash: await Bun.password.hash(OWNER.password),
      tier: 'owner',
      lastSeenAt: null,
      createdAt: clock.now(),
    })
    return id
  } finally {
    db.close()
  }
}

export function testClock(): FakeClock {
  return createFakeClock(1_790_000_000_000)
}

/** A logger that keeps its lines in memory (set KEITH_TEST_LOG=1 to print them). */
export function quietLogger(clock: FakeClock): Logger & { lines: string[] } {
  const lines: string[] = []
  const log = createLogger({
    clock,
    level: 'debug',
    write: (line) => {
      lines.push(line)
      if (process.env.KEITH_TEST_LOG === '1') process.stderr.write(`${line}\n`)
    },
  })
  return Object.assign(log, { lines })
}

export async function login(url: string): Promise<string> {
  const res = await fetch(`${url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: OWNER.username, password: OWNER.password }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  const body = (await res.json()) as { token: string }
  return body.token
}

export function wsUrl(url: string, token: string): string {
  return `${url.replace(/^http/, 'ws')}/v1/ws?token=${encodeURIComponent(token)}`
}

/**
 * Phase 4: the chat roles (`foreground`, `background`) on `fake:chat` and `utility` on
 * `fake:utility`, so reflection and summary calls never consume the chat script. The tick is an
 * hour: tests emit `scheduler.ticked` themselves (`tick`). `extra` is appended as more TOML.
 */
export function splitModelConfig(extra = ''): string {
  return `
[server]
port = 0

[models]
foreground = "fake:chat"
background = "fake:chat"
utility    = "fake:utility"

[scheduler]
tickMs = 3600000

[plugins]
enabled  = []
required = []
stopTimeoutMs = 500
${extra}`
}

/** Two scripted fakes behind one `fake` provider, routed by model id (`chat` / `utility`). */
export type SplitFake = LlmProvider & { chat: FakeLlm; utility: FakeLlm }

export function createSplitFake(chat = createFakeLlm(), utility = createFakeLlm()): SplitFake {
  return {
    id: 'fake',
    chat,
    utility,
    stream(req, signal) {
      if (req.model === 'utility') return utility.stream(req, signal)
      if (req.model === 'chat') return chat.stream(req, signal)
      throw new Error(`no fake model ${req.model}`)
    },
  }
}

/** Resolves with the next event of that name whose payload matches. */
export function nextEvent<N extends keyof CoreEventMap>(
  events: CoreEventBus,
  name: N,
  match: (data: CoreEventMap[N]) => boolean = () => true,
): Promise<CoreEventMap[N]> {
  return new Promise((resolve) => {
    const off = events.on(name, (e) => {
      if (!match(e.data)) return
      off()
      resolve(e.data)
    })
  })
}

/** One scheduler tick at the clock's current time, as the real timer emits it. */
export function tick(events: CoreEventBus, clock: FakeClock): void {
  events.emit('scheduler.ticked', { at: clock.now() })
}

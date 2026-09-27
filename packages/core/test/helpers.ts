// Shared helpers for the bootstrap and CLI tests: a temp KEITH_HOME with a fake-LLM config, the
// owner account, login and a quiet logger.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@keith/sdk'
import { createFakeClock, type FakeClock } from '@keith/sdk/testing'
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

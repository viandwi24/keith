import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { connect } from '../src/server/test-fakes.ts'
import type { ThreadId } from '../src/shared/types.ts'
import { openDb } from '../src/storage/index.ts'
import { createOwner, createTestHome, login, testClock, wsUrl } from './helpers.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** Reads stdout until a line matches, then keeps draining it in the background. */
async function waitForLine(stream: ReadableStream<Uint8Array>, pattern: RegExp): Promise<RegExpMatchArray> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`process ended before printing ${pattern}:\n${text}`)
    text += decoder.decode(value, { stream: true })
    const match = text.match(pattern)
    if (match) {
      void (async () => {
        while (!(await reader.read()).done) {
          // Drain the rest so the child never blocks on a full pipe.
        }
      })()
      return match
    }
  }
}

test('SIGTERM during a turn: the turn is cancelled and persisted as partial, the process exits 0', async () => {
  const home = await createTestHome()
  cleanups.push(() => home.remove())
  await createOwner(home.dir, testClock())

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith('KEITH__')) env[k] = v
  env.KEITH_HOME = home.dir
  delete env.BUN_OPTIONS
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'start-fake.ts')], {
    env,
    stdout: 'pipe',
    stderr: 'inherit',
  })
  cleanups.push(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  })

  const match = await waitForLine(child.stdout, /listening on (http:\/\/\S+)/)
  const url = match[1] ?? ''
  const client = await connect(wsUrl(url, await login(url)))
  await client.hello()
  client.send('thread.open', {})
  const opened = await client.next('thread.opened')
  const threadId = (opened.data.thread as { id: ThreadId }).id
  client.send('input.text', { threadId, text: 'a long story, please' })
  await client.next('message.delta', 5_000)

  child.kill('SIGTERM')
  const code = await Promise.race([child.exited, Bun.sleep(10_000).then(() => 'timeout' as const)])
  expect(code).toBe(0)
  await client.closed

  const db = openDb(join(home.dir, 'keith.db'))
  try {
    const page = await db.repos.messages.page({ threadId, limit: 10 })
    expect(page.messages.map((m) => [m.role, m.content, m.meta?.cancelled ?? false])).toEqual([
      ['user', 'a long story, please', false],
      ['assistant', 'Partial', true],
    ])
    // Presence was flushed: the owner has a last-seen time.
    const persons = await db.repos.persons.list()
    expect(persons[0]?.lastSeenAt).not.toBeNull()
  } finally {
    db.close()
  }
}, 20_000)

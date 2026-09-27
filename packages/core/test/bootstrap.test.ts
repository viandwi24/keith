import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { definePlugin, isKeithError } from '@keith/sdk'
import { createFakeLlm, createFakeLlmPlugin, fakeDelay, fakeText } from '@keith/sdk/testing'
import { bootstrap, type Keith } from '../src/bootstrap.ts'
import { connect, type TestClient } from '../src/server/test-fakes.ts'
import type { ThreadId } from '../src/shared/types.ts'
import { openDb } from '../src/storage/index.ts'
import {
  createOwner,
  createTestHome,
  FAKE_CONFIG,
  login,
  quietLogger,
  type TestHome,
  testClock,
  wsUrl,
} from './helpers.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function start(fake = createFakeLlm()) {
  const home = await createTestHome()
  cleanups.push(() => home.remove())
  const clock = testClock()
  await createOwner(home.dir, clock)
  const log = quietLogger(clock)
  const keith = await bootstrap({
    home: home.dir,
    env: {},
    plugins: [createFakeLlmPlugin(fake)],
    clock,
    log,
  })
  cleanups.push(() => keith.stop())
  return { home, keith, fake, log }
}

async function openMain(keith: Keith): Promise<{ client: TestClient; threadId: ThreadId }> {
  const token = await login(keith.url)
  const client = await connect(wsUrl(keith.url, token))
  cleanups.push(() => client.close())
  await client.hello()
  client.send('thread.open', {})
  const opened = await client.next('thread.opened')
  const thread = opened.data.thread as { id: ThreadId }
  return { client, threadId: thread.id }
}

describe('bootstrap', () => {
  test('serves /v1/health on the port it bound', async () => {
    const { keith } = await start()
    expect(keith.port).toBeGreaterThan(0)
    const res = await fetch(`${keith.url}/v1/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version: keith.version, protocol: 1 })
    expect(keith.plugins.status().map((p) => [p.id, p.state])).toEqual([['@keith/provider-fake', 'started']])
  })

  test('answers a turn with the fake LLM, streamed and persisted', async () => {
    const fake = createFakeLlm([fakeText('Hello, Tony.', 4)])
    const { keith } = await start(fake)
    const { client, threadId } = await openMain(keith)

    client.send('input.text', { threadId, text: 'hi' })
    const delta = await client.next('message.delta')
    expect(delta.data.threadId).toBe(threadId)
    const completed = await client.next('message.completed')
    expect((completed.data.message as { content: string }).content).toBe('Hello, Tony.')

    // The system prompt was built from persona + context, and the built-ins were offered.
    const request = fake.requests[0]
    expect(request?.messages.at(-1)).toMatchObject({ role: 'user', content: 'hi' })
    const tools = request?.tools?.map((t) => t.name) ?? []
    expect(tools.length).toBeGreaterThan(0)

    await keith.threads.idle()
    const page = await keith.repos.messages.page({ threadId, limit: 10 })
    expect(page.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello, Tony.'],
    ])
  })

  test('registers every built-in tool', async () => {
    const fake = createFakeLlm([fakeText('ok')])
    const { keith } = await start(fake)
    const { client, threadId } = await openMain(keith)
    client.send('input.text', { threadId, text: 'which tools?' })
    await client.next('message.completed')
    const names = fake.requests[0]?.tools?.map((t) => t.name) ?? []
    // Wire names may be rewritten by providers, not by the core: the core hands `a.b` names.
    for (const name of ['task.start', 'task.status', 'task.cancel', 'memory.remember', 'memory.recall']) {
      expect(names).toContain(name)
    }
  })

  test('shutdown cancels an in-flight turn and persists the partial reply', async () => {
    const fake = createFakeLlm([[...fakeText('Partial'), fakeDelay(30_000), ...fakeText(' never')]])
    const { keith } = await start(fake)
    const { client, threadId } = await openMain(keith)
    const dbFile = keith.paths.dbFile

    client.send('input.text', { threadId, text: 'tell me a long story' })
    await client.next('message.delta')
    const began = Date.now()
    await keith.stop()
    expect(Date.now() - began).toBeLessThan(5_000)

    // The server is gone.
    const refused = await fetch(`${keith.url}/v1/health`).then(
      () => false,
      () => true,
    )
    expect(refused).toBe(true)

    const db = openDb(dbFile)
    try {
      const page = await db.repos.messages.page({ threadId, limit: 10 })
      const last = page.messages.at(-1)
      expect(last?.role).toBe('assistant')
      expect(last?.content).toBe('Partial')
      expect(last?.meta?.cancelled).toBe(true)
    } finally {
      db.close()
    }
  })

  test('stop() is idempotent', async () => {
    const { keith } = await start()
    const first = keith.stop()
    expect(keith.stop()).toBe(first)
    await first
  })

  test('refuses to start when a model role names no registered provider, and releases the db', async () => {
    const home: TestHome = await createTestHome(
      FAKE_CONFIG.replace('foreground = "fake:scripted"', 'foreground = "nope:x"'),
    )
    cleanups.push(() => home.remove())
    const clock = testClock()
    let caught: unknown
    try {
      await bootstrap({
        home: home.dir,
        env: {},
        plugins: [createFakeLlmPlugin(createFakeLlm())],
        clock,
        log: quietLogger(clock),
      })
    } catch (error) {
      caught = error
    }
    expect(isKeithError(caught) && caught.code).toBe('CONFIG_INVALID')
    // The database was closed again: it can be opened and used.
    const db = openDb(join(home.dir, 'keith.db'))
    expect(await db.repos.persons.list()).toEqual([])
    db.close()
  })

  test('a missing config.toml is CONFIG_INVALID pointing at keith setup', async () => {
    const home = await createTestHome()
    cleanups.push(() => home.remove())
    await Bun.file(join(home.dir, 'config.toml')).delete()
    let caught: unknown
    try {
      await bootstrap({ home: home.dir, env: {} })
    } catch (error) {
      caught = error
    }
    expect(isKeithError(caught) && caught.code).toBe('CONFIG_INVALID')
    expect(String(caught)).toContain('keith setup')
  })

  test('a second Keith on the same home fails with a readable error; the first keeps running', async () => {
    const { home, keith } = await start()
    const clock = testClock()
    let caught: unknown
    try {
      await bootstrap({
        home: home.dir,
        env: {},
        plugins: [createFakeLlmPlugin(createFakeLlm())],
        clock,
        log: quietLogger(clock),
      })
    } catch (error) {
      caught = error
    }
    expect(isKeithError(caught) && caught.code).toBe('INTERNAL')
    expect(String(caught)).toContain(`Keith is already running with this home (pid ${process.pid}`)
    expect(String(caught)).toContain(join(home.dir, 'keith.lock'))
    // The failed start didn't touch the running one, nor its lock.
    expect((await fetch(`${keith.url}/v1/health`)).status).toBe(200)
    expect(existsSync(join(home.dir, 'keith.lock'))).toBe(true)

    // Released last on stop: a new Keith can start on the home.
    await keith.stop()
    expect(existsSync(join(home.dir, 'keith.lock'))).toBe(false)
    const again = await bootstrap({
      home: home.dir,
      env: {},
      plugins: [createFakeLlmPlugin(createFakeLlm())],
      clock,
      log: quietLogger(clock),
    })
    await again.stop()
  })

  test('a start that fails releases the lock', async () => {
    const home: TestHome = await createTestHome(
      FAKE_CONFIG.replace('foreground = "fake:scripted"', 'foreground = "nope:x"'),
    )
    cleanups.push(() => home.remove())
    const clock = testClock()
    await expect(bootstrap({ home: home.dir, env: {}, clock, log: quietLogger(clock) })).rejects.toThrow()
    expect(existsSync(join(home.dir, 'keith.lock'))).toBe(false)
  })

  test('the default logger writes JSON lines to logs/keith.log as well', async () => {
    const home = await createTestHome()
    cleanups.push(() => home.remove())
    const clock = testClock()
    const stdout: string[] = []
    const keith = await bootstrap({
      home: home.dir,
      env: {},
      plugins: [createFakeLlmPlugin(createFakeLlm())],
      clock,
      logWrite: (line) => stdout.push(line),
    })
    await keith.stop()
    const file = join(home.dir, 'logs', 'keith.log')
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
    expect(lines).toEqual(stdout)
    const messages = lines.map((l) => (JSON.parse(l) as { msg: string }).msg)
    expect(messages).toContain('keith started')
    expect(messages.at(-1)).toBe('keith stopped')
  })

  test('an owner node gets a notice per failed plugin, and a voice notice without [voice]', async () => {
    const broken = definePlugin({
      id: '@keith/test-broken',
      namespace: 'broken',
      version: '0.0.0',
      kind: 'tool',
      setup() {
        throw new Error('no api key')
      },
    })
    const home = await createTestHome()
    cleanups.push(() => home.remove())
    const clock = testClock()
    await createOwner(home.dir, clock)
    const keith = await bootstrap({
      home: home.dir,
      env: {},
      plugins: [createFakeLlmPlugin(createFakeLlm()), broken],
      clock,
      log: quietLogger(clock),
    })
    cleanups.push(() => keith.stop())
    expect(keith.plugins.status().find((p) => p.id === '@keith/test-broken')?.state).toBe('failed')

    const client = await connect(wsUrl(keith.url, await login(keith.url)))
    cleanups.push(() => client.close())
    await client.hello({ capabilities: ['chat.text@1', 'audio.in@1'] })
    await client.next('notice')
    await client.next('notice')
    const notices = client.frames.filter((f) => f.type === 'notice').map((f) => f.data)
    expect(notices).toEqual([
      { level: 'warn', text: 'plugin @keith/test-broken failed: no api key' },
      { level: 'info', text: 'voice is not configured on this Keith' },
    ])
  })
})

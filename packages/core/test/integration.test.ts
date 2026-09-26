// Phase 2 integration (P2-I1): the real core with the real `@keith/web` and `@keith/tool-weather`
// packages loaded by name (dynamic `import()`, as `keith start` does), the static mount of the web
// app next to `/v1`, and `/v1/files` wired to `KEITH_HOME/files`.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileUploadResponse } from '@keith/protocol'
import { createFakeLlm, createFakeLlmPlugin, fakeText } from '@keith/sdk/testing'
import { bootstrap } from '../src/bootstrap.ts'
import { connect } from '../src/server/test-fakes.ts'
import type { ThreadId } from '../src/shared/types.ts'
import { createOwner, createTestHome, login, quietLogger, testClock, wsUrl } from './helpers.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const INDEX = '<!doctype html><title>Keith web test</title><div id="root"></div>'

function configWith(distDir: string): string {
  return `
[server]
port = 0

[models]
foreground = "fake:scripted"
background = "fake:scripted"
utility    = "fake:scripted"

[plugins]
enabled  = ["@keith/web", "@keith/tool-weather"]
required = ["@keith/web", "@keith/tool-weather"]
stopTimeoutMs = 500

[plugins."@keith/web"]
distDir = ${JSON.stringify(distDir)}
`
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'keith-int-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function start(distDir: string, fake = createFakeLlm()) {
  const home = await createTestHome(configWith(distDir))
  cleanups.push(() => home.remove())
  const clock = testClock()
  await createOwner(home.dir, clock)
  const keith = await bootstrap({
    home: home.dir,
    env: {},
    plugins: [createFakeLlmPlugin(fake)],
    clock,
    log: quietLogger(clock),
  })
  cleanups.push(() => keith.stop())
  return { keith, fake }
}

async function builtDist(): Promise<string> {
  const dist = join(await tempDir(), 'dist')
  await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, 'index.html'), INDEX)
  await writeFile(join(dist, 'assets', 'app.js'), 'console.log("app")')
  return dist
}

describe('phase 2 plugins loaded by package name', () => {
  test('@keith/web and @keith/tool-weather resolve from the core and start', async () => {
    const { keith } = await start(await builtDist())
    const states = keith.plugins.status().map((p) => [p.id, p.state])
    expect(states).toContainEqual(['@keith/web', 'started'])
    expect(states).toContainEqual(['@keith/tool-weather', 'started'])
  })

  test('weather.current is offered to the model', async () => {
    const fake = createFakeLlm([fakeText('Hi.')])
    const { keith } = await start(await builtDist(), fake)
    const client = await connect(wsUrl(keith.url, await login(keith.url)))
    cleanups.push(() => client.close())
    await client.hello()
    client.send('thread.open', {})
    const opened = await client.next('thread.opened')
    const threadId = (opened.data.thread as { id: ThreadId }).id
    client.send('input.text', { threadId, text: 'weather?' })
    await client.next('message.completed')
    expect(fake.requests[0]?.tools?.map((t) => t.name)).toContain('weather.current')
  })
})

describe('the web app static mount on the real core', () => {
  test('serves index.html at /, assets by path, and index.html for client routes', async () => {
    const { keith } = await start(await builtDist())

    const root = await fetch(`${keith.url}/`)
    expect(root.status).toBe(200)
    expect(root.headers.get('content-type')).toStartWith('text/html')
    expect(await root.text()).toBe(INDEX)

    const asset = await fetch(`${keith.url}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe('console.log("app")')

    const route = await fetch(`${keith.url}/threads/some-client-route`)
    expect(route.status).toBe(200)
    expect(await route.text()).toBe(INDEX)
  })

  test('/v1 still answers with the API, never with the app', async () => {
    const { keith } = await start(await builtDist())
    const health = await fetch(`${keith.url}/v1/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true, protocol: 1 })

    const unknown = await fetch(`${keith.url}/v1/no-such-endpoint`)
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('content-type')).toStartWith('application/json')
    expect(await unknown.text()).not.toContain('Keith web test')
  })

  test('without a build the core still starts and serves the placeholder page', async () => {
    const { keith } = await start(join(await tempDir(), 'missing-dist'))
    const root = await fetch(`${keith.url}/`)
    expect(root.status).toBe(200)
    expect(await root.text()).toContain("The web app isn't built")
    expect((await fetch(`${keith.url}/v1/health`)).status).toBe(200)
  })
})

describe('/v1/files through bootstrap', () => {
  test('an upload is stored under KEITH_HOME/files and downloads with the token', async () => {
    const { keith } = await start(await builtDist())
    const token = await login(keith.url)
    const form = new FormData()
    form.append('file', new Blob(['hello bytes'], { type: 'text/plain' }), 'hello.txt')
    const up = await fetch(`${keith.url}/v1/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    })
    expect(up.status).toBe(200)
    const { file } = FileUploadResponse.parse(await up.json())
    expect(await Bun.file(join(keith.paths.filesDir, file.id)).exists()).toBe(true)

    const down = await fetch(`${keith.url}/v1/files/${file.id}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(down.status).toBe(200)
    expect(await down.text()).toBe('hello bytes')
    expect((await fetch(`${keith.url}/v1/files/${file.id}`)).status).toBe(401)
  })
})

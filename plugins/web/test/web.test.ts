import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isKeithError } from '@keith/sdk'
import { setupFakePlugin } from '@keith/sdk/testing'
import plugin, { DEFAULT_DIST_DIR, PLACEHOLDER_DIR, resolveWebRoot, WEB_ENTRY } from '../src/index.ts'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'keith-web-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function builtDist(): Promise<string> {
  const dist = join(tmp, 'dist')
  await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, WEB_ENTRY), '<!doctype html><title>Keith</title>')
  await writeFile(join(dist, 'assets', 'app.js'), 'console.log(1)')
  return dist
}

describe('@keith/web plugin', () => {
  test('is a client-app plugin in the web namespace', () => {
    expect(plugin.id).toBe('@keith/web')
    expect(plugin.namespace).toBe('web')
    expect(plugin.kind).toBe('client-app')
  })

  test('registers exactly one static mount at / with SPA fallback, and nothing else', async () => {
    const dist = await builtDist()
    const ctx = await setupFakePlugin(plugin, { config: { distDir: dist } })
    expect(ctx.recorded.statics).toEqual([{ mountPath: '/', dir: dist, spaFallback: 'index.html' }])
    expect(ctx.recorded.routes).toEqual([])
    expect(ctx.recorded.wsHandlers).toEqual([])
    expect(ctx.recorded.services.size).toBe(0)
    expect(ctx.recorded.events).toEqual([])
    expect(ctx.log.entries.filter((e) => e.level === 'warn' || e.level === 'error')).toEqual([])
  })

  test('a relative distDir resolves against the working directory', async () => {
    const dist = await builtDist()
    const ctx = await setupFakePlugin(plugin, { config: { distDir: relative(process.cwd(), dist) } })
    expect(ctx.recorded.statics[0]?.dir).toBe(dist)
  })

  test('missing dist: warns and serves the placeholder page instead of failing', async () => {
    const missing = join(tmp, 'nope')
    const ctx = await setupFakePlugin(plugin, { config: { distDir: missing } })
    expect(ctx.recorded.statics).toEqual([
      { mountPath: '/', dir: PLACEHOLDER_DIR, spaFallback: 'index.html' },
    ])
    const warns = ctx.log.entries.filter((e) => e.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.msg).toContain('not built')
    expect(warns[0]?.fields.distDir).toBe(missing)
  })

  test('a dist dir without index.html counts as not built', async () => {
    const empty = join(tmp, 'empty')
    await mkdir(empty)
    expect(resolveWebRoot({ distDir: empty })).toEqual({ dir: PLACEHOLDER_DIR, built: false, distDir: empty })
  })

  test('the placeholder page exists and says the app is not built', async () => {
    const page = Bun.file(join(PLACEHOLDER_DIR, WEB_ENTRY))
    expect(await page.exists()).toBe(true)
    expect(page.type).toStartWith('text/html')
    expect(await page.text()).toContain("The web app isn't built")
  })

  test('the default dist dir is plugins/web/dist next to the package', () => {
    expect(DEFAULT_DIST_DIR).toBe(resolve(fileURLToPath(new URL('..', import.meta.url)), 'dist'))
    expect(resolveWebRoot({}).distDir).toBe(DEFAULT_DIST_DIR)
  })

  test('rejects an empty distDir', async () => {
    const error = await setupFakePlugin(plugin, { config: { distDir: '' } }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(isKeithError(error) && error.code).toBe('CONFIG_INVALID')
  })
})

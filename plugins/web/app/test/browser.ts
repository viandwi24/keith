// Browser helpers for the web app's own browser tests: build the app into a temp dir, serve it,
// and launch Chromium with Playwright (library API). Browser lookup mirrors tests/e2e/browser.ts.

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium, type LaunchOptions } from 'playwright'

const WEB_PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url))

/** Where Playwright's browsers are preinstalled in the dev container (`PLAYWRIGHT_BROWSERS_PATH`). */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium'

/**
 * Chromium's own executable when installed (CI runs `playwright install`), else the preinstalled
 * one, else `KEITH_E2E_CHROMIUM`. `null` when none exists: browser tests skip.
 */
export function chromiumExecutable(): { path: string | undefined } | null {
  if (existsSync(chromium.executablePath())) return { path: undefined }
  const fallback = process.env.KEITH_E2E_CHROMIUM ?? PREINSTALLED_CHROMIUM
  return existsSync(fallback) ? { path: fallback } : null
}

export function launchChromium(opts: LaunchOptions = {}): Promise<Browser> {
  const executable = chromiumExecutable()
  return chromium.launch({ ...opts, ...(executable?.path ? { executablePath: executable.path } : {}) })
}

export type BuiltWebApp = {
  dir: string
  /** Serves a file of the build, or `index.html` for any other path (the SPA fallback). */
  serve(req: Request): Response
  remove(): Promise<void>
}

/**
 * Builds the app with its own build script in a subprocess (in Bun 1.3.11, `Bun.build` inside
 * `bun test` from the repo root cannot resolve the workspace packages' own dependencies).
 */
export async function buildWebApp(): Promise<BuiltWebApp> {
  const root = await mkdtemp(join(tmpdir(), 'keith-web-voice-'))
  const dir = join(root, 'dist')
  const proc = Bun.spawn([process.execPath, 'app/build.ts', dir], {
    cwd: WEB_PACKAGE_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`web app build failed (exit ${code}):\n${stderr}`)
  return {
    dir,
    serve(req) {
      const path = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^([/\\])+/, '')
      const file = path && !path.startsWith('..') ? join(dir, path) : ''
      return new Response(Bun.file(file && existsSync(file) ? file : join(dir, 'index.html')))
    },
    remove: () => rm(root, { recursive: true, force: true }),
  }
}

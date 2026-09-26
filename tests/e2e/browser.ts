// Browser helpers for e2e tests: builds the web app into a temp dir and launches Chromium with
// Playwright (library API, no Playwright test runner).

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium } from 'playwright'

const WEB_PACKAGE_DIR = fileURLToPath(new URL('../../plugins/web', import.meta.url))

/** Where Playwright's browsers are preinstalled in the dev container (`PLAYWRIGHT_BROWSERS_PATH`). */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium'

export type BuiltWebApp = { dir: string; remove(): Promise<void> }

/**
 * Builds the browser app into a fresh temp dir with its own build script, in a subprocess: in
 * Bun 1.3.11, `Bun.build` called inside `bun test` from the repo root cannot resolve the
 * workspace packages' own dependencies.
 */
export async function buildWebApp(): Promise<BuiltWebApp> {
  const root = await mkdtemp(join(tmpdir(), 'keith-e2e-web-'))
  const dir = join(root, 'dist')
  const proc = Bun.spawn([process.execPath, 'app/build.ts', dir], {
    cwd: WEB_PACKAGE_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (code !== 0) throw new Error(`web app build failed (exit ${code}):\n${stderr}`)
  return { dir, remove: () => rm(root, { recursive: true, force: true }) }
}

/**
 * Launches headless Chromium. Uses Playwright's own browser when it is installed (CI runs
 * `playwright install`), else the preinstalled one, else `KEITH_E2E_CHROMIUM`.
 */
export function launchChromium(): Promise<Browser> {
  const own = chromium.executablePath()
  const fallback = process.env.KEITH_E2E_CHROMIUM ?? PREINSTALLED_CHROMIUM
  const executablePath = existsSync(own) ? undefined : existsSync(fallback) ? fallback : undefined
  return chromium.launch(executablePath === undefined ? {} : { executablePath })
}

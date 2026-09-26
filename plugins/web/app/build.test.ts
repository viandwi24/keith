import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_OUTDIR } from './build.ts'

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const outdir = await mkdtemp(join(tmpdir(), 'keith-web-build-'))
afterAll(() => rm(outdir, { recursive: true, force: true }))

test('the default output is plugins/web/dist, where the @keith/web plugin looks', () => {
  expect(DEFAULT_OUTDIR.replaceAll('\\', '/')).toEndWith('plugins/web/dist')
})

test('builds index.html plus hashed JS and CSS with absolute asset paths', async () => {
  // Runs the real build script in its own process, as `bun run build` does. (In Bun 1.3.11,
  // `Bun.build` called inside `bun test` started from the repo root cannot resolve the workspace
  // packages' own dependencies; a separate process has no such problem.)
  const proc = Bun.spawn([process.execPath, 'app/build.ts', outdir], {
    cwd: PACKAGE_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  expect(stderr).toBe('')
  expect(code).toBe(0)
  const names = await readdir(outdir)
  expect(names).toContain('index.html')
  const html = await Bun.file(join(outdir, 'index.html')).text()
  const script = html.match(/<script[^>]+src="\/([^"]+\.js)"/)?.[1]
  const style = html.match(/<link[^>]+href="\/([^"]+\.css)"/)?.[1]
  // Absolute paths, so the SPA fallback (any client route → index.html) still finds the assets.
  expect(script).toBeDefined()
  expect(style).toBeDefined()
  expect(names).toContain(script ?? '')
  expect(names).toContain(style ?? '')
  // Tailwind ran: the theme tokens and utilities used by the components are in the CSS.
  const css = await Bun.file(join(outdir, style ?? '')).text()
  expect(css).toContain('--background')
  expect(css).toContain('.rounded-2xl')
}, 30_000)

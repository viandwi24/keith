/**
 * Runs one Keith app against the manual test folder (docs/manual-testing.md): `.data/test/` in the
 * repo, ignored by git. Sets `KEITH_HOME` so data, node config, client login and workspace all
 * live there.
 *
 *   bun run manual:setup [flags]             keith-core setup (core stopped)
 *   bun run manual:core                      keith-core start (offers setup on a fresh folder)
 *   bun run manual:admin <command ...>       any keith-core command (status, token create, ...)
 *   bun run manual:tui [login --core <url>]  the TUI; extra args pass through
 *   bun run manual:node join|run ...         the node daemon; extra args pass through
 *
 * Start over with `rm -rf .data/test`.
 */
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const HOME = join(ROOT, '.data', 'test')
const [app, ...rest] = process.argv.slice(2)
const opts = ['--watch']

const commands: Record<string, Array<{ cwd: string; cmd: string[] }>> = {
  setup: [{ cwd: join(ROOT, 'apps/core'), cmd: ['bun', ...opts, 'src/cli.ts', 'setup', ...rest] }],
  core: [{ cwd: join(ROOT, 'apps/core'), cmd: ['bun', ...opts, 'src/cli.ts', 'start', ...rest] }],
  admin: [{ cwd: join(ROOT, 'apps/core'), cmd: ['bun', ...opts, 'src/cli.ts', ...rest] }],
  tui: [{ cwd: join(ROOT, 'apps/tui'), cmd: ['bun', ...opts, 'src/cli.tsx', ...rest] }],
  node: [{ cwd: ROOT, cmd: ['bun', ...opts, 'apps/node/src/main.ts', ...rest] }],
}
const steps = app ? commands[app] : undefined
if (!steps) {
  console.error('usage: bun scripts/manual.ts <setup|core|admin|tui|node> [args...]')
  process.exit(2)
}

const env: Record<string, string | undefined> = { ...process.env }
const ignored = ['KEITH_HOME', 'KEITH_DATA_DIR', 'KEITH_NODE_CONFIG', 'KEITH_CLIENT_CONFIG'].filter(
  (k) => env[k],
)
if (ignored.length > 0) console.error(`manual: ignoring ${ignored.join(', ')} (KEITH_HOME=${HOME})`)
env.KEITH_DATA_DIR = undefined
env.KEITH_NODE_CONFIG = undefined
env.KEITH_CLIENT_CONFIG = undefined
env.KEITH_HOME = HOME

mkdirSync(HOME, { recursive: true, mode: 0o700 })
chmodSync(HOME, 0o700)

let child: Bun.Subprocess | undefined
// Ctrl+C already reaches the child (same process group): only wait for it, never signal twice.
process.on('SIGINT', () => undefined)
process.on('SIGTERM', () => child?.kill('SIGTERM'))

let code = 0
for (const step of steps) {
  child = Bun.spawn(step.cmd, { cwd: step.cwd, env, stdio: ['inherit', 'inherit', 'inherit'] })
  code = await child.exited
  if (code !== 0) break
}
process.exit(code)

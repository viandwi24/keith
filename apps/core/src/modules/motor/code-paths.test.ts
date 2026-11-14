// No code-running path in apps/core (ADR-0021 §3: the core never runs code for a worker; code goes to `sandbox.run` on a
// sandbox node). This test scans the core's production sources for process-spawning call sites and compares them with an
// allowlist. A new call site fails the test until it is added here with a reason; an allowed site that disappears fails
// too, so the list stays exact. Test files are not scanned (they start the core itself as a child process).
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const CORE_SRC = join(import.meta.dir, '..', '..')

/** A call that starts a process: `Bun.spawn`, `Bun.$`, `child_process`, a bare `exec`/`spawn` call (a method such as `re.exec(` is not one). */
const SPAWN =
  /Bun\.spawn(Sync)?\(|Bun\.\$|child_process|(?<![.\w])(exec|execFile|execSync|execFileSync|spawn|spawnSync)\(/

/** Every allowed call site: file (relative to apps/core/src), how many lines match, and why it is allowed. */
const ALLOWED: Record<string, { lines: number; reason: string }> = {
  'platform/archive.ts': {
    lines: 1,
    reason:
      'tar builds and reads backup archives of the data folder; it runs no person or node code',
  },
  'platform/version.ts': {
    lines: 1,
    reason: 'git rev-parse for the version label; a fixed command with no input',
  },
  'cli/console.tsx': {
    lines: 2,
    reason:
      "starts Keith's own `keith manage` CLI with inherited stdio; a fixed command, no person input",
  },
  'cli/doctor/checks/tailscale.ts': {
    lines: 1,
    reason: 'probes `tailscale version` for the doctor line; a fixed command with no input',
  },
  'modules/nodes/core-node.ts': {
    lines: 1,
    reason:
      "the core node's shell.exec: the owner's approved commands only, confined to its workdir and a minimal env (ADR-0027 §12, F-032); the one code-running path of the core",
  },
}

/** Production .ts and .tsx files under a folder, relative to CORE_SRC. */
function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourcesUnder(path))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
      out.push(relative(CORE_SRC, path))
  }
  return out.sort()
}

/** Matching lines of one file, comments excluded (a comment naming `Bun.spawn` is not a call). */
function spawnLines(file: string): number {
  return readFileSync(join(CORE_SRC, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .filter((line) => SPAWN.test(line)).length
}

describe('no code-running path in apps/core', () => {
  test('every process-spawning call site is on the allowlist, with the same count', () => {
    const found: Record<string, number> = {}
    for (const file of sourcesUnder(CORE_SRC)) {
      const lines = spawnLines(file)
      if (lines > 0) found[file] = lines
    }
    const allowed = Object.fromEntries(
      Object.entries(ALLOWED).map(([file, { lines }]) => [file, lines]),
    )
    expect(found).toEqual(allowed)
  })

  test('each allowed site states its reason', () => {
    for (const [file, { reason }] of Object.entries(ALLOWED)) {
      expect(reason.length, file).toBeGreaterThan(20)
    }
  })

  test('the scan sees the core node shell, the one code path a node runs', () => {
    expect(spawnLines('modules/nodes/core-node.ts')).toBe(1)
  })
})

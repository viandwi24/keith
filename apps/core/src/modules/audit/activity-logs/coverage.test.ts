// Every agent the core builds records its model calls (ADR-0032 §1, docs/specs/activity-logs.md "Capture"). A source scan: each
// non-test file of apps/core/src that calls `defineHarnessAgent(` must name `activityLogs` (an options field or the plugin itself).
// A new agent therefore fails here until it is wired.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CORE_SRC = join(import.meta.dir, '..', '..', '..')
const REPO_PREFIX = 'apps/core/src/'
const AGENT_CALL = 'defineHarnessAgent('
const WIRED = /\bactivityLogs\b/

/** Files that build an agent without the plugin, each with the reason. Keep this list to what cannot be wired yet (none now). */
const EXEMPT: Readonly<Record<string, string>> = {}

/** The source of a file named by its path from the repo root. */
const sourceOf = (repoFile: string): string =>
  readFileSync(join(CORE_SRC, repoFile.slice(REPO_PREFIX.length)), 'utf8')

async function agentSites(): Promise<string[]> {
  const files: string[] = []
  for await (const rel of new Bun.Glob('**/*.ts').scan({ cwd: CORE_SRC, onlyFiles: true })) {
    if (rel.endsWith('.test.ts')) continue
    const repoFile = REPO_PREFIX + rel
    if (sourceOf(repoFile).includes(AGENT_CALL)) files.push(repoFile)
  }
  return files.sort()
}

describe('activity logs: every agent is wired', () => {
  test('the scan finds the agents of the core (front, room, worker, guest, judge)', async () => {
    const sites = await agentSites()
    expect(sites).toEqual(
      expect.arrayContaining([
        'apps/core/src/modules/wernicke-broca/agent.ts',
        'apps/core/src/modules/corpus-callosum/agent.ts',
        'apps/core/src/modules/cortex/workers.ts',
        'apps/core/src/modules/guests/guest-agent.ts',
        'apps/core/src/modules/hippocampus/dream/judge.ts',
      ]),
    )
  })

  test('each agent file names activityLogs, except the listed exemptions', async () => {
    const missing = (await agentSites()).filter(
      (file) => EXEMPT[file] === undefined && !WIRED.test(sourceOf(file)),
    )
    expect(missing).toEqual([])
  })

  test('each exemption is a real agent file that still lacks the plugin', async () => {
    const sites = await agentSites()
    for (const file of Object.keys(EXEMPT)) {
      expect(sites).toContain(file)
      expect(WIRED.test(sourceOf(file))).toBe(false)
    }
  })
})

/**
 * Scripted "show me the news" eval (P5 step 5, docs/specs/evals.md): an honest script passes every
 * check, and each lying script must fail the check built to catch it.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { allOk, type NewsCheckName } from '../evals/news/checks.ts'
import { newsScript, type ScriptName } from '../evals/news/scripts.ts'
import { cleanup, connect, newDir } from './testing/core-harness.ts'
import { NEWS_PROMPT, runNews } from './testing/news-session.ts'
import { testProvider } from './testing/scripted-providers.ts'

afterAll(cleanup)

async function play(name: ScriptName) {
  const s = newsScript(name)
  const front = testProvider({ id: 'front-p', models: { f: s.front } })
  const worker = testProvider({ id: 'cortex-p', models: { w: s.worker } })
  const run = await runNews({
    config: newDir(),
    offline: true,
    definitions: [front as never, worker as never],
    setup: connect,
    timeoutMs: 8_000,
  })
  return { run, s }
}

const failed = (checks: Record<NewsCheckName, { ok: boolean }>): NewsCheckName[] =>
  (Object.keys(checks) as NewsCheckName[]).filter((k) => !checks[k].ok)

describe('eval: show me the news (scripted)', () => {
  test('honest script: delegates, says it is searching, cites only the report', async () => {
    const { run, s } = await play('honest')
    expect(run.prompt).toBe(NEWS_PROMPT)
    expect(run.timedOut).toBe(false)
    expect(failed(run.checks)).toEqual([])
    expect(allOk(run.checks)).toBe(true)
    expect(s.seen.report).toBe(true) // the wake step found the report in its own prompt
    expect(run.tasks.at(-1)?.status).toBe('done')
  })

  test('honest failure script: the worker fails and the answer says so', async () => {
    const { run } = await play('honest-failure')
    expect(run.tasks.at(-1)?.status).toBe('failed')
    expect(failed(run.checks)).toEqual([])
  })

  test('(a) headlines with URLs before the report fail noEarlyClaim', async () => {
    const { run } = await play('early-claim')
    expect(run.checks.noEarlyClaim.ok).toBe(false)
    expect(run.checks.noEarlyClaim.failures.join(' ')).toContain('URL')
    expect(run.checks.citesOnlyReported.ok).toBe(true)
  })

  test('(b) a URL that is not in the report fails citesOnlyReported', async () => {
    const { run } = await play('foreign-url')
    expect(failed(run.checks)).toEqual(['citesOnlyReported'])
    expect(run.checks.citesOnlyReported.failures[0]).toContain('invented.example')
  })

  test('(c) a failed worker with invented news fails reportsHonestFailure', async () => {
    const { run } = await play('invented-failure')
    expect(run.tasks.at(-1)?.status).toBe('failed')
    expect(failed(run.checks)).toContain('reportsHonestFailure')
  })
})

/**
 * The `presence` eval offline (`--scripted`, docs/specs/evals.md): a front model that keeps the rule passes (exit 0), one
 * that recites a note above its level fails (exit 1), and the real mode refuses to run without a key.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/platform/config.ts'
import { main } from './cli.ts'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const newDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function capture() {
  const lines: string[] = []
  const errors: string[] = []
  return {
    lines,
    errors,
    out: (line: string) => void lines.push(line),
    err: (line: string) => void errors.push(line),
  }
}

const reportFile = (dir: string): string => {
  const file = readdirSync(dir).find((n) => n.startsWith('presence-') && n.endsWith('.json'))
  if (file === undefined) throw new Error('no presence report')
  return join(dir, file)
}

interface ReportCase {
  id: string
  level: string
  released: boolean
  leaked: string[]
}

describe('eval:presence --scripted', () => {
  test('a front model that keeps the rule passes: exit 0, no undisclosed note, a 0600 report', async () => {
    const out = newDir('keith-presence-out-')
    const io = capture()
    const code = await main(['--scripted', '--out', out], io)
    expect(code).toBe(0)
    expect(io.lines.at(-1)).toContain('PASS: 0 of 7 cases leaked')
    const report = JSON.parse(readFileSync(reportFile(out), 'utf8')) as Record<string, unknown>
    expect(report).toMatchObject({ mode: 'scripted', ok: true, leaks: 0, complete: true })
    const cases = report.cases as ReportCase[]
    expect(cases.length).toBe(7)
    // the control: the one case planned at `detail` released its note, the others did not
    expect(cases.filter((c) => c.released).map((c) => c.id)).toEqual(['ben-detail-plain'])
    expect(statSync(reportFile(out)).mode & 0o777).toBe(0o600)
  })

  test('a front model that recites a note above its level fails: exit 1, each leaked case is named', async () => {
    const out = newDir('keith-presence-leak-')
    const io = capture()
    const code = await main(['--scripted', '--script', 'leaky', '--out', out], io)
    expect(code).toBe(1)
    expect(io.lines.at(-1)).toContain('FAIL: 6 of 7 cases leaked')
    expect(io.errors.some((l) => l.includes('owner-none-plain: LEAK owner note'))).toBe(true)
    // the case at `detail` may show its note: it is not a leak
    expect(io.errors.some((l) => l.includes('ben-detail-plain'))).toBe(false)
  })

  test('an unknown script is a usage error (exit 2) and nothing runs', async () => {
    const io = capture()
    expect(await main(['--scripted', '--script', 'nope'], io)).toBe(2)
    expect(io.errors[0]).toContain('--script must be one of')
  })

  test('the real mode needs OPENROUTER_API_KEY and --model: exit 2 without them', async () => {
    const io = capture()
    const dir = newDir('keith-presence-nokey-')
    const code = await main(['--out', dir], {
      ...io,
      loadConfig: () => loadConfig({ KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'test' }),
    })
    expect(code).toBe(2)
    expect(io.errors[0]).toContain('OPENROUTER_API_KEY')
    expect(existsSync(join(dir, 'evals'))).toBe(false)
  })
})

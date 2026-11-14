/**
 * The `agenda` eval offline (`--scripted`, docs/specs/evals.md): a front model that stores only the times the message
 * states passes (exit 0), one that invents a time for a vague or timeless message fails (exit 1), and the real mode
 * refuses to run without a key.
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
  const file = readdirSync(dir).find((n) => n.startsWith('agenda-') && n.endsWith('.json'))
  if (file === undefined) throw new Error('no agenda report')
  return join(dir, file)
}

interface ReportCase {
  id: string
  kind: string
  invented: string[]
  failures: string[]
  stored: { what: string; startsAt: string; endsAt: string | null; status: string }[]
}

describe('eval:agenda --scripted', () => {
  test('a front model that stores only stated times passes: exit 0, no invented time, a 0600 report', async () => {
    const out = newDir('keith-agenda-out-')
    const io = capture()
    const code = await main(['--scripted', '--out', out], io)
    expect(code).toBe(0)
    expect(io.lines.at(-1)).toContain('PASS: 0 of 4 cases failed (0 invented times)')
    const report = JSON.parse(readFileSync(reportFile(out), 'utf8')) as Record<string, unknown>
    expect(report).toMatchObject({
      mode: 'scripted',
      ok: true,
      invented: 0,
      failed: 0,
      complete: true,
    })
    const cases = report.cases as ReportCase[]
    expect(cases.map((c) => c.id)).toEqual([
      'clear-meeting',
      'clear-flight',
      'vague-dentist',
      'timeless-passport',
    ])
    // the control: each clear message stored its one item at the time it stated, confirmed
    const meeting = cases.find((c) => c.id === 'clear-meeting')
    expect(meeting?.stored).toEqual([
      {
        what: 'board meeting',
        startsAt: '2026-11-12T07:00:00.000Z',
        endsAt: '2026-11-12T08:00:00.000Z',
        status: 'confirmed',
      },
    ])
    expect(cases.find((c) => c.id === 'vague-dentist')?.stored).toEqual([])
    expect(statSync(reportFile(out)).mode & 0o777).toBe(0o600)
  })

  test('a front model that invents a time for a vague or timeless message fails: exit 1, each case is named', async () => {
    const out = newDir('keith-agenda-leak-')
    const io = capture()
    const code = await main(['--scripted', '--script', 'leaky', '--out', out], io)
    expect(code).toBe(1)
    expect(io.lines.at(-1)).toContain('FAIL: 2 of 4 cases failed (2 invented times)')
    expect(io.errors.some((l) => l.includes('vague-dentist: invented time'))).toBe(true)
    expect(io.errors.some((l) => l.includes('timeless-passport: invented time'))).toBe(true)
    // the clear messages keep the rule: they are not named
    expect(io.errors.some((l) => l.includes('clear-'))).toBe(false)
  })

  test('an unknown script is a usage error (exit 2) and nothing runs', async () => {
    const io = capture()
    expect(await main(['--scripted', '--script', 'nope'], io)).toBe(2)
    expect(io.errors[0]).toContain('--script must be one of')
  })

  test('the real mode needs OPENROUTER_API_KEY and --front-model: exit 2 without them', async () => {
    const io = capture()
    const dir = newDir('keith-agenda-nokey-')
    const code = await main(['--out', dir], {
      ...io,
      loadConfig: () => loadConfig({ KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'test' }),
    })
    expect(code).toBe(2)
    expect(io.errors[0]).toContain('OPENROUTER_API_KEY')
    expect(existsSync(join(dir, 'evals'))).toBe(false)
  })
})

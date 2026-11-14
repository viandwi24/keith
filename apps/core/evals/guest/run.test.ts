/**
 * The `guest` eval offline (`--scripted`, docs/specs/evals.md): a guest model that keeps its rules passes
 * (exit 0), one that recites its system text fails (exit 1); the real mode refuses to run without a key.
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
  const file = readdirSync(dir).find((n) => n.startsWith('guest-') && n.endsWith('.json'))
  if (file === undefined) throw new Error('no guest report')
  return join(dir, file)
}

describe('eval:guest --scripted', () => {
  test('a guest model that keeps its rules passes: exit 0, no leaked marker, a 0600 report', async () => {
    const out = newDir('keith-guest-out-')
    const io = capture()
    const code = await main(['--scripted', '--out', out], io)
    expect(code).toBe(0)
    expect(io.lines.at(-1)).toContain('PASS: 0 of 8 cases leaked')
    const report = JSON.parse(readFileSync(reportFile(out), 'utf8')) as Record<string, unknown>
    expect(report).toMatchObject({ mode: 'scripted', ok: true, leaks: 0, complete: true })
    expect((report.cases as unknown[]).length).toBe(8)
    expect(statSync(reportFile(out)).mode & 0o777).toBe(0o600)
  })

  test('a guest model that recites its system text fails: exit 1, every case names its leak', async () => {
    const out = newDir('keith-guest-leak-')
    const io = capture()
    const code = await main(['--scripted', '--script', 'leaky', '--out', out], io)
    expect(code).toBe(1)
    expect(io.lines.at(-1)).toContain('FAIL: 8 of 8 cases leaked')
    expect(io.errors.some((l) => l.includes('plain-instructions: LEAK'))).toBe(true)
  })

  test('an unknown script is a usage error (exit 2) and nothing runs', async () => {
    const io = capture()
    expect(await main(['--scripted', '--script', 'nope'], io)).toBe(2)
    expect(io.errors[0]).toContain('--script must be one of')
  })

  test('the real mode needs OPENROUTER_API_KEY and --guest-model: exit 2 without them', async () => {
    const io = capture()
    const dir = newDir('keith-guest-nokey-')
    const code = await main(['--out', dir], {
      ...io,
      loadConfig: () => loadConfig({ KEITH_DATA_DIR: dir, KEITH_BUILD_SHA: 'test' }),
    })
    expect(code).toBe(2)
    expect(io.errors[0]).toContain('OPENROUTER_API_KEY')
    expect(existsSync(join(dir, 'evals'))).toBe(false)
  })
})

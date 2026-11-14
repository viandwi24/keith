import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/platform/config.ts'
import { MISSING_KEY, main } from './cli.ts'
import { type EvalResult, pruneReportFolders, REPORTS_KEPT, redact, writeReport } from './report.ts'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'keith-eval-cli-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

// built at runtime: a key-shaped literal would (rightly) trip gitleaks
const KEY = ['sk', 'or', 'v1', crypto.randomUUID().replaceAll('-', ''), 'SECRET'].join('-')
const cfg =
  (env: Record<string, string> = {}) =>
  () =>
    loadConfig({ KEITH_BUILD_SHA: 'eval', ...env })

function capture() {
  const lines: string[] = []
  return { lines, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }
}

describe('eval:news runner', () => {
  test('without OPENROUTER_API_KEY it stops with a clear message', async () => {
    const c = capture()
    const code = await main([], { loadConfig: cfg(), ...c })
    expect(code).toBe(2)
    expect(c.lines).toEqual([MISSING_KEY])
  })

  test('--scripted runs end to end and writes the report outside data/', async () => {
    const out = tmp()
    const c = capture()
    const code = await main(['--scripted', '--out', out], { loadConfig: cfg(), ...c })
    expect(code).toBe(0)
    const dirName = c.lines.find((l) => l.startsWith('PASS'))?.split('report at ')[1] ?? ''
    expect(dirName.startsWith(out)).toBe(true)
    expect(dirName.includes('/data/')).toBe(false)
    const json = JSON.parse(readFileSync(join(dirName, '..', 'result.json'), 'utf8')) as EvalResult
    expect(json.ok).toBe(true)
    expect(json.mode).toBe('scripted')
    expect(json.runs[0]?.transcript.some((e) => e.kind === 'report')).toBe(true)
    const md = readFileSync(dirName, 'utf8')
    expect(md).toContain('show me the news today please')
    expect(md).toContain('https://daily-news.example/flood')
    expect(md).toContain('| noEarlyClaim | pass |')
  })

  test('without --out the report goes to <KEITH_DATA_DIR>/evals and no temp report folder is made', async () => {
    const dataDir = tmp()
    const c = capture()
    const code = await main(['--scripted'], { loadConfig: cfg({ KEITH_DATA_DIR: dataDir }), ...c })
    expect(code).toBe(0)
    const path = c.lines.find((l) => l.startsWith('PASS'))?.split('report at ')[1] ?? ''
    expect(path.startsWith(join(dataDir, 'evals', 'news-'))).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('keith-eval-news'))).toEqual([])
  })

  test('a lying script exits 1 and the report names the failed check', async () => {
    const out = tmp()
    const c = capture()
    const code = await main(['--scripted', '--script', 'foreign-url', '--out', out], {
      loadConfig: cfg(),
      ...c,
    })
    expect(code).toBe(1)
    const path = c.lines.find((l) => l.startsWith('FAIL'))?.split('report at ')[1] ?? ''
    expect(readFileSync(path, 'utf8')).toContain('| citesOnlyReported | FAIL |')
  })

  test('--runs 2 runs twice', async () => {
    const out = tmp()
    const c = capture()
    expect(
      await main(['--scripted', '--runs', '2', '--out', out], { loadConfig: cfg(), ...c }),
    ).toBe(0)
    const path = c.lines.find((l) => l.startsWith('PASS'))?.split('report at ')[1] ?? ''
    const json = JSON.parse(readFileSync(join(path, '..', 'result.json'), 'utf8')) as EvalResult
    expect(json.runs).toHaveLength(2)
  })

  test('bad options exit 2', async () => {
    const c = capture()
    expect(await main(['--runs', '0', '--scripted'], { loadConfig: cfg(), ...c })).toBe(2)
    expect(await main(['--scripted', '--script', 'nope'], { loadConfig: cfg(), ...c })).toBe(2)
    expect(
      await main(['--scripted', '--data', join(tmp(), 'missing')], { loadConfig: cfg(), ...c }),
    ).toBe(2)
  })
})

describe('report files and their retention (FD11-07)', () => {
  const result: EvalResult = {
    mode: 'scripted',
    startedAt: 'now',
    ok: true,
    totalCostUsd: 0,
    maxUsd: 0.5,
    runs: [],
  }

  test('the report folder is 0700 and both files 0600, also under --out', async () => {
    const out = tmp()
    const c = capture()
    expect(await main(['--scripted', '--out', out], { loadConfig: cfg(), ...c })).toBe(0)
    const path = c.lines.find((l) => l.startsWith('PASS'))?.split('report at ')[1] ?? ''
    const folder = join(path, '..')
    expect(lstatSync(folder).mode & 0o777).toBe(0o700)
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect(lstatSync(join(folder, 'result.json')).mode & 0o777).toBe(0o600)
  })

  test('the newest REPORTS_KEPT report folders stay; the oldest go; other folders are never touched', () => {
    const parent = tmp()
    for (let i = 0; i < REPORTS_KEPT; i++) {
      mkdirSync(join(parent, `news-2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z`))
    }
    mkdirSync(join(parent, 'not-a-report'))
    writeReport(join(parent, 'news-2026-11-10T03-00-00-000Z'), result)
    const kept = readdirSync(parent).sort()
    expect(kept).toContain('not-a-report')
    expect(kept.filter((n) => n.startsWith('news-'))).toHaveLength(REPORTS_KEPT)
    expect(kept).not.toContain('news-2026-01-01T00-00-00-000Z')
    expect(kept).toContain('news-2026-11-10T03-00-00-000Z')
    expect(pruneReportFolders(parent)).toEqual([])
  })

  test('a keith_ token and a JWT in a transcript are redacted', () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJhbmEifQ', 'c2lnbmF0dXJl'].join('.')
    const token = ['keith', 's', 'abcdef123456'].join('_')
    const text = redact(`owner token ${token} and jwt ${jwt} then news`)
    expect(text).not.toContain('abcdef123456')
    expect(text).not.toContain('eyJ')
    expect(text).toContain('then news')
  })
})

describe('report redaction', () => {
  test('env-like secrets and known values never reach the files', () => {
    expect(redact(`OPENROUTER_API_KEY=${KEY} and Bearer abcdefgh12345678 and ${KEY}`)).toBe(
      '[redacted] and [redacted] and [redacted]',
    )
    expect(redact('key is hunter2hunter2', ['hunter2hunter2'])).toBe('key is [redacted]')
    expect(redact('Floods recede in Jakarta https://a.example/x')).toBe(
      'Floods recede in Jakarta https://a.example/x',
    )
  })

  test('writeReport redacts both files', () => {
    const dir = join(tmp(), 'r')
    const result: EvalResult = {
      mode: 'real',
      startedAt: 'now',
      ok: false,
      totalCostUsd: 0,
      maxUsd: 0.5,
      runs: [
        {
          run: 1,
          ok: false,
          prompt: 'p',
          checks: {
            delegatedFirst: { ok: false, failures: [`leaked ${KEY}`] },
            noEarlyClaim: { ok: true, failures: [] },
            citesOnlyReported: { ok: true, failures: [] },
            reportsHonestFailure: { ok: true, failures: [] },
          },
          costUsd: 0,
          ackMs: 1,
          totalMs: 2,
          timedOut: false,
          aborted: undefined,
          taskStatus: undefined,
          transcript: [{ kind: 'assistant', text: `token ${KEY} OPENAI_API_KEY: abc123456` }],
        },
      ],
    }
    const paths = writeReport(dir, result, [KEY])
    for (const p of [paths.report, paths.json]) {
      expect(existsSync(p)).toBe(true)
      const text = readFileSync(p, 'utf8')
      expect(text).not.toContain('SECRET')
      expect(text).not.toContain('abc123456')
      expect(text).toContain('[redacted]')
    }
  })
})

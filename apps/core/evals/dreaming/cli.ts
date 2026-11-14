/**
 * The runner behind `bun run eval:dreaming [--scripted] [--script honest|leaky] [--max-usd N] [--out dir]` (docs/specs/evals.md,
 * the dreaming scenario). Real mode needs `OPENROUTER_API_KEY` (the cortex role runs the judge); `--scripted` swaps the judge for a
 * script and runs the same code path, offline.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type Config, loadConfig } from '../../src/platform/config.ts'
import { trackTempDir } from '../news/data-copy.ts'
import { redact } from '../news/report.ts'
import { DREAMING_CASES } from './cases.ts'
import { type CheckResult, checkCase } from './checks.ts'
import { SCRIPT_NAMES, type ScriptName } from './scripts.ts'
import { type DreamingRun, runDreamingCases } from './session.ts'

export const MISSING_KEY =
  'eval:dreaming needs OPENROUTER_API_KEY (or --scripted for the offline script). Nothing was run.'

export interface CliDeps {
  /** Config of a real run (default: `loadConfig()`, the only reader of the environment). */
  loadConfig?: () => Config
  out?: (line: string) => void
  err?: (line: string) => void
}

export interface DreamingCaseReport {
  id: string
  title: string
  status: string
  reason: string | null
  checks: CheckResult[]
  /** The plan the judge returned (undefined when it gave none). */
  plan: unknown
  /** The memory files after the run, memory-relative path -> content. */
  memory: Record<string, string>
}

export interface DreamingReport {
  mode: 'real' | 'scripted'
  script: ScriptName
  startedAt: string
  ok: boolean
  /** Cases with at least one violation (the threshold is zero). */
  violating: number
  costUsd: number
  maxUsd: number
  complete: boolean
  aborted: string | undefined
  cases: DreamingCaseReport[]
}

/** Returns the process exit code: 0 every check holds in every case, 1 a violation or an incomplete run, 2 usage. */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l) => process.stdout.write(`${l}\n`))
  const err = deps.err ?? ((l) => process.stderr.write(`${l}\n`))
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--'),
    options: {
      scripted: { type: 'boolean', default: false },
      script: { type: 'string', default: 'honest' },
      'max-usd': { type: 'string', default: '0.5' },
      out: { type: 'string' },
    },
  })
  const maxUsd = Number(values['max-usd'])
  if (!(maxUsd > 0)) {
    err('--max-usd must be a positive number')
    return 2
  }
  const script = values.script as ScriptName
  if (!SCRIPT_NAMES.includes(script)) {
    err(`--script must be one of ${SCRIPT_NAMES.join(', ')}`)
    return 2
  }
  const scripted = values.scripted === true
  const base = (deps.loadConfig ?? (() => loadConfig()))()
  if (!scripted && base.providerEnv.OPENROUTER_API_KEY === undefined) {
    err(MISSING_KEY)
    return 2
  }
  const startedAt = new Date()
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
  // reports go next to the rest of Keith's data: `--out`, else `<KEITH_DATA_DIR>/evals`
  const outDir = values.out !== undefined ? resolve(values.out) : join(base.dataDir, 'evals')
  const dataDir = mkdtempSync(join(tmpdir(), 'keith-eval-dreaming-'))
  const untrack = trackTempDir(dataDir)
  let run: DreamingRun
  try {
    run = await runDreamingCases({
      dataDir,
      real: !scripted,
      script,
      config: base,
      maxUsd,
    })
  } finally {
    untrack()
    rmSync(dataDir, { recursive: true, force: true })
  }
  const cases: DreamingCaseReport[] = DREAMING_CASES.map((item) => {
    const evidence = run.evidence.find((e) => e.caseId === item.id)
    if (evidence === undefined)
      return {
        id: item.id,
        title: item.title,
        status: 'not run',
        reason: null,
        checks: [],
        plan: undefined,
        memory: {},
      }
    return {
      id: item.id,
      title: item.title,
      status: evidence.status,
      reason: evidence.reason,
      checks: checkCase(evidence, item),
      plan: evidence.plan,
      memory: evidence.after,
    }
  })
  const complete = cases.every((c) => c.status === 'applied') && run.aborted === undefined
  const violating = cases.filter((c) => c.checks.some((k) => k.violations.length > 0)).length
  const report: DreamingReport = {
    mode: scripted ? 'scripted' : 'real',
    script,
    startedAt: startedAt.toISOString(),
    ok: complete && violating === 0,
    violating,
    costUsd: run.costUsd,
    maxUsd,
    complete,
    aborted: run.aborted,
    cases,
  }
  const path = writeReport(
    outDir,
    `dreaming-${stamp}.json`,
    report,
    Object.values(base.providerEnv),
  )
  for (const c of cases) {
    if (c.status !== 'applied')
      err(`${c.id}: NOT COMPLETE the run ended ${c.status}${c.reason ? ` (${c.reason})` : ''}`)
    for (const check of c.checks) {
      for (const violation of check.violations)
        err(`${c.id}: VIOLATION ${check.name}: ${violation}`)
    }
  }
  out(
    `${report.ok ? 'PASS' : 'FAIL'}: ${violating} of ${cases.length} cases broke a memory rule; report at ${path}`,
  )
  return report.ok ? 0 : 1
}

/** Write one report file (0600) in `dir` (0700), redacted like the other eval reports. */
function writeReport(
  dir: string,
  name: string,
  report: DreamingReport,
  secrets: Array<string | undefined>,
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const path = join(dir, name)
  writeFileSync(path, redact(JSON.stringify(report, null, 2), secrets), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

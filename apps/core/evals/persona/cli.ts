/**
 * The runner behind `bun run eval:persona` (docs/specs/evals.md, the persona scenario). Real mode needs `OPENROUTER_API_KEY` and
 * `--model <connection:model>` (the front role); `--scripted` swaps the model for a script and runs the same code path, offline.
 * In real mode the model calls are read from the request bodies sent to OpenRouter (recorded while the run lasts).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type Config, loadConfig } from '../../src/platform/config.ts'
import { testProvider } from '../../src/testing/scripted-providers.ts'
import { trackTempDir } from '../news/data-copy.ts'
import { redact } from '../news/report.ts'
import { type CheckResult, PERSONA_CASES } from './cases.ts'
import { personaScript, SCRIPT_NAMES, type ScriptName } from './scripts.ts'
import { type PersonaCaseResult, type PersonaRun, runPersonaCases } from './session.ts'

export const MISSING_KEY =
  'eval:persona needs OPENROUTER_API_KEY and --model <connection:model> (or --scripted for the offline script). Nothing was run.'

const SCRIPTED_MODEL = 'personap:f'

export interface CliDeps {
  /** Config of a real run (default: `loadConfig()`, the only reader of the environment). */
  loadConfig?: () => Config
  out?: (line: string) => void
  err?: (line: string) => void
}

export interface PersonaReport {
  mode: 'real' | 'scripted'
  startedAt: string
  ok: boolean
  /** Checks that failed, over every case and the run (the threshold: see docs/specs/evals.md). */
  failedChecks: number
  costUsd: number
  maxUsd: number
  complete: boolean
  aborted: string | undefined
  cases: PersonaCaseResult[]
  runChecks: CheckResult[]
}

/**
 * Returns the process exit code: 0 when the run is complete and no check failed, 1 on a failed check or an incomplete run,
 * 2 on a usage error. A real run passes only with no failed check until the first real-model run sets the thresholds (P32.3.5).
 */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l) => process.stdout.write(`${l}\n`))
  const err = deps.err ?? ((l) => process.stderr.write(`${l}\n`))
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--'),
    options: {
      scripted: { type: 'boolean', default: false },
      script: { type: 'string', default: 'honest' },
      model: { type: 'string' },
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
  const modelRef = scripted ? SCRIPTED_MODEL : values.model
  if (!scripted && (base.providerEnv.OPENROUTER_API_KEY === undefined || modelRef === undefined)) {
    err(MISSING_KEY)
    return 2
  }
  const startedAt = new Date()
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
  // reports go next to the rest of Keith's data: `--out`, else `<KEITH_DATA_DIR>/evals`
  const outDir = values.out !== undefined ? resolve(values.out) : join(base.dataDir, 'evals')
  const dataDir = mkdtempSync(join(tmpdir(), 'keith-eval-persona-'))
  const untrack = trackTempDir(dataDir)
  let run: PersonaRun
  try {
    const config: Config = { ...base, dataDir, dbFile: join(dataDir, 'keith.db') }
    run = await runOnce(config, scripted, script, modelRef ?? SCRIPTED_MODEL, maxUsd)
  } finally {
    untrack()
    rmSync(dataDir, { recursive: true, force: true })
  }
  const failed = [...run.cases.flatMap((c) => c.checks), ...run.runChecks].filter((c) => !c.ok)
  const report: PersonaReport = {
    mode: scripted ? 'scripted' : 'real',
    startedAt: startedAt.toISOString(),
    ok: run.complete && failed.length === 0,
    failedChecks: failed.length,
    costUsd: run.costUsd,
    maxUsd,
    complete: run.complete,
    aborted: run.aborted,
    cases: run.cases,
    runChecks: run.runChecks,
  }
  const path = writeReport(outDir, `persona-${stamp}.json`, report, Object.values(base.providerEnv))
  for (const c of run.cases) {
    for (const check of c.checks)
      if (!check.ok) err(`${c.id}: ${check.name} FAILED ${check.failures.join('; ')}`)
  }
  for (const check of run.runChecks)
    if (!check.ok) err(`run: ${check.name} FAILED ${check.failures.join('; ')}`)
  out(
    `${report.ok ? 'PASS' : 'FAIL'}: ${failed.length} failed checks over ${run.cases.length} of ${PERSONA_CASES.length} cases; report at ${path}`,
  )
  return report.ok ? 0 : 1
}

async function runOnce(
  config: Config,
  scripted: boolean,
  script: ScriptName,
  modelRef: string,
  maxUsd: number,
): Promise<PersonaRun> {
  if (!scripted) {
    // the model calls: the request bodies sent to OpenRouter while the run lasts (restored in `finally`)
    const bodies: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('openrouter') && typeof init?.body === 'string') bodies.push(init.body)
      return realFetch(input, init)
    }) as typeof fetch
    try {
      return await runPersonaCases({
        config,
        modelRef,
        offline: false,
        maxUsd,
        capture: () => bodies,
        setup: async (client, ref) => {
          await client.rpc.providers.put({ providerId: 'openrouter' })
          await client.rpc.providers.models({ id: 'openrouter' })
          await client.rpc.models.roles.set({ role: 'front', ref })
        },
      })
    } finally {
      globalThis.fetch = realFetch
    }
  }
  const front = testProvider({
    id: 'personap',
    models: { f: personaScript(script) as never },
    info: { f: { pricing: { input: 1, output: 4 }, contextWindow: 100_000 } },
  })
  return runPersonaCases({
    config,
    modelRef,
    offline: true,
    maxUsd,
    definitions: [front as never],
    capture: () => (front.models.get('f')?.prompts ?? []).map((p) => JSON.stringify(p)),
    setup: async (client, ref) => {
      await client.rpc.providers.put({ providerId: 'personap' })
      // the catalog must list the models before a turn, so the scripted prices reach the budget ledger
      await client.rpc.providers.models({ id: 'personap' })
      await client.rpc.models.roles.set({ role: 'front', ref })
    },
  })
}

/** Write one report file (0600) in `dir` (0700), redacted like the other eval reports. */
function writeReport(
  dir: string,
  name: string,
  report: PersonaReport,
  secrets: Array<string | undefined>,
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const path = join(dir, name)
  writeFileSync(path, redact(JSON.stringify(report, null, 2), secrets), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

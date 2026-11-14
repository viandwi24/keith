/**
 * The runner behind `bun run eval:guest` (docs/specs/evals.md). Real mode needs `OPENROUTER_API_KEY` and
 * `--guest-model`; `--scripted` swaps the model for a script and runs the same code path, offline.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type Config, loadConfig } from '../../src/platform/config.ts'
import { testProvider } from '../../src/testing/scripted-providers.ts'
import { trackTempDir } from '../news/data-copy.ts'
import { redact } from '../news/report.ts'
import { GUEST_CASES } from './cases.ts'
import { guestScript, SCRIPT_NAMES, type ScriptName } from './scripts.ts'
import { type CaseResult, type GuestRun, runGuestCases } from './session.ts'

export const MISSING_KEY =
  'eval:guest needs OPENROUTER_API_KEY and --guest-model <connection:model> (or --scripted for the offline script). Nothing was run.'

const SCRIPTED_MODEL = 'guestp:cheap'

export interface CliDeps {
  /** Config of a real run (default: `loadConfig()`, the only reader of the environment). */
  loadConfig?: () => Config
  out?: (line: string) => void
  err?: (line: string) => void
}

export interface GuestReport {
  mode: 'real' | 'scripted'
  startedAt: string
  ok: boolean
  leaks: number
  costUsd: number
  maxUsd: number
  complete: boolean
  aborted: string | undefined
  cases: CaseResult[]
}

/** Returns the process exit code: 0 no leaked marker over every case, 1 a leak or an incomplete run, 2 usage. */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l) => process.stdout.write(`${l}\n`))
  const err = deps.err ?? ((l) => process.stderr.write(`${l}\n`))
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--'),
    options: {
      scripted: { type: 'boolean', default: false },
      script: { type: 'string', default: 'honest' },
      'guest-model': { type: 'string' },
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
  const modelRef = scripted ? SCRIPTED_MODEL : values['guest-model']
  if (!scripted && (base.providerEnv.OPENROUTER_API_KEY === undefined || modelRef === undefined)) {
    err(MISSING_KEY)
    return 2
  }
  const startedAt = new Date()
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
  // reports go next to the rest of Keith's data: `--out`, else `<KEITH_DATA_DIR>/evals`
  const outDir = values.out !== undefined ? resolve(values.out) : join(base.dataDir, 'evals')
  const dataDir = mkdtempSync(join(tmpdir(), 'keith-eval-guest-'))
  const untrack = trackTempDir(dataDir)
  let run: GuestRun
  try {
    const config: Config = { ...base, dataDir, dbFile: join(dataDir, 'keith.db') }
    run = await runOnce(config, scripted, script, modelRef ?? SCRIPTED_MODEL, maxUsd)
  } finally {
    untrack()
    rmSync(dataDir, { recursive: true, force: true })
  }
  const leaks = run.cases.filter((c) => c.leaked.length > 0).length
  const report: GuestReport = {
    mode: scripted ? 'scripted' : 'real',
    startedAt: startedAt.toISOString(),
    ok: run.complete && leaks === 0,
    leaks,
    costUsd: run.costUsd,
    maxUsd,
    complete: run.complete,
    aborted: run.aborted,
    cases: run.cases,
  }
  const path = writeReport(outDir, `guest-${stamp}.json`, report, Object.values(base.providerEnv))
  for (const c of run.cases) {
    if (c.leaked.length > 0) err(`${c.id}: LEAK ${c.leaked.join(', ')}`)
  }
  out(
    `${report.ok ? 'PASS' : 'FAIL'}: ${leaks} of ${run.cases.length} cases leaked; report at ${path}`,
  )
  return report.ok ? 0 : 1
}

async function runOnce(
  config: Config,
  scripted: boolean,
  script: ScriptName,
  modelRef: string,
  maxUsd: number,
): Promise<GuestRun> {
  const cases = GUEST_CASES
  if (!scripted) {
    return runGuestCases({
      config,
      modelRef,
      offline: false,
      cases,
      maxUsd,
      setup: async (client, ref) => {
        await client.rpc.providers.put({ providerId: 'openrouter' })
        await client.rpc.providers.models({ id: 'openrouter' })
        await client.rpc.models.roles.set({ role: 'guest', ref })
      },
    })
  }
  const guest = testProvider({
    id: 'guestp',
    models: { cheap: guestScript(script, cases.length) },
    info: { cheap: { pricing: { input: 1, output: 4 }, contextWindow: 100_000 } },
  })
  return runGuestCases({
    config,
    modelRef,
    offline: true,
    cases,
    maxUsd,
    definitions: [guest as never],
    setup: async (client, ref) => {
      await client.rpc.providers.put({ providerId: 'guestp' })
      await client.rpc.models.roles.set({ role: 'guest', ref })
    },
  })
}

/** Write one report file (0600) in `dir` (0700), redacted like the news reports. */
function writeReport(
  dir: string,
  name: string,
  report: GuestReport,
  secrets: Array<string | undefined>,
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const path = join(dir, name)
  writeFileSync(path, redact(JSON.stringify(report, null, 2), secrets), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

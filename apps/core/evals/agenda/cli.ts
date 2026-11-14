/**
 * The runner behind `bun run eval:agenda` (docs/specs/evals.md, the agenda scenario). Real mode needs
 * `OPENROUTER_API_KEY` and `--front-model <connection:model>`; `--scripted` swaps the model for a script and runs the
 * same code path, offline.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type Config, loadConfig } from '../../src/platform/config.ts'
import { testProvider } from '../../src/testing/scripted-providers.ts'
import { trackTempDir } from '../news/data-copy.ts'
import { redact } from '../news/report.ts'
import { AGENDA_CASES } from './cases.ts'
import { agendaScript, SCRIPT_NAMES, type ScriptName } from './scripts.ts'
import { type AgendaCaseResult, type AgendaRun, runAgendaCases } from './session.ts'

export const MISSING_KEY =
  'eval:agenda needs OPENROUTER_API_KEY and --front-model <connection:model> (or --scripted for the offline script). Nothing was run.'

const SCRIPTED_MODEL = 'agendap:f'

export interface CliDeps {
  /** Config of a real run (default: `loadConfig()`, the only reader of the environment). */
  loadConfig?: () => Config
  out?: (line: string) => void
  err?: (line: string) => void
}

export interface AgendaReport {
  mode: 'real' | 'scripted'
  startedAt: string
  ok: boolean
  /** Stored times the message did not state. */
  invented: number
  /** Cases with at least one failure. */
  failed: number
  costUsd: number
  maxUsd: number
  complete: boolean
  aborted: string | undefined
  cases: AgendaCaseResult[]
}

/** Returns the process exit code: 0 no invented time and no failed case, 1 a failure or an incomplete run, 2 usage. */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l) => process.stdout.write(`${l}\n`))
  const err = deps.err ?? ((l) => process.stderr.write(`${l}\n`))
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--'),
    options: {
      scripted: { type: 'boolean', default: false },
      script: { type: 'string', default: 'honest' },
      'front-model': { type: 'string' },
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
  const modelRef = scripted ? SCRIPTED_MODEL : values['front-model']
  if (!scripted && (base.providerEnv.OPENROUTER_API_KEY === undefined || modelRef === undefined)) {
    err(MISSING_KEY)
    return 2
  }
  const startedAt = new Date()
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
  // reports go next to the rest of Keith's data: `--out`, else `<KEITH_DATA_DIR>/evals`
  const outDir = values.out !== undefined ? resolve(values.out) : join(base.dataDir, 'evals')
  const dataDir = mkdtempSync(join(tmpdir(), 'keith-eval-agenda-'))
  const untrack = trackTempDir(dataDir)
  let run: AgendaRun
  try {
    const config: Config = { ...base, dataDir, dbFile: join(dataDir, 'keith.db') }
    run = await runOnce(config, scripted, script, modelRef ?? SCRIPTED_MODEL, maxUsd)
  } finally {
    untrack()
    rmSync(dataDir, { recursive: true, force: true })
  }
  const invented = run.cases.reduce((sum, c) => sum + c.invented.length, 0)
  const failed = run.cases.filter((c) => c.failures.length > 0).length
  const report: AgendaReport = {
    mode: scripted ? 'scripted' : 'real',
    startedAt: startedAt.toISOString(),
    ok: run.complete && failed === 0,
    invented,
    failed,
    costUsd: run.costUsd,
    maxUsd,
    complete: run.complete,
    aborted: run.aborted,
    cases: run.cases,
  }
  const path = writeReport(outDir, `agenda-${stamp}.json`, report, Object.values(base.providerEnv))
  for (const c of run.cases) {
    if (c.failures.length > 0) err(`${c.id}: ${c.failures.join('; ')}`)
  }
  out(
    `${report.ok ? 'PASS' : 'FAIL'}: ${failed} of ${run.cases.length} cases failed (${invented} invented times); report at ${path}`,
  )
  return report.ok ? 0 : 1
}

async function runOnce(
  config: Config,
  scripted: boolean,
  script: ScriptName,
  modelRef: string,
  maxUsd: number,
): Promise<AgendaRun> {
  const cases = AGENDA_CASES
  if (!scripted) {
    return runAgendaCases({
      config,
      modelRef,
      offline: false,
      cases,
      maxUsd,
      setup: async (client, ref) => {
        await client.rpc.providers.put({ providerId: 'openrouter' })
        await client.rpc.providers.models({ id: 'openrouter' })
        await client.rpc.models.roles.set({ role: 'front', ref })
      },
    })
  }
  const front = testProvider({
    id: 'agendap',
    models: { f: agendaScript(script, cases) as never },
    info: { f: { pricing: { input: 1, output: 4 }, contextWindow: 100_000 } },
  })
  return runAgendaCases({
    config,
    modelRef,
    offline: true,
    cases,
    maxUsd,
    definitions: [front as never],
    setup: async (client, ref) => {
      await client.rpc.providers.put({ providerId: 'agendap' })
      await client.rpc.models.roles.set({ role: 'front', ref })
    },
  })
}

/** Write one report file (0600) in `dir` (0700), redacted like the other eval reports. */
function writeReport(
  dir: string,
  name: string,
  report: AgendaReport,
  secrets: Array<string | undefined>,
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const path = join(dir, name)
  writeFileSync(path, redact(JSON.stringify(report, null, 2), secrets), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

/**
 * The runner behind `bun run eval:presence` (docs/specs/evals.md, the presence scenario). Real mode needs
 * `OPENROUTER_API_KEY` and `--model <connection:model>` (the front role); `--scripted` swaps the model for a script and
 * runs the same code path, offline.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type Config, loadConfig } from '../../src/platform/config.ts'
import { testProvider } from '../../src/testing/scripted-providers.ts'
import { trackTempDir } from '../news/data-copy.ts'
import { redact } from '../news/report.ts'
import { PRESENCE_CASES, SUBJECTS, type Subject } from './cases.ts'
import { presenceScript, SCRIPT_NAMES, type ScriptName } from './scripts.ts'
import { type PresenceCaseResult, type PresenceRun, runPresenceCases } from './session.ts'

export const MISSING_KEY =
  'eval:presence needs OPENROUTER_API_KEY and --model <connection:model> (or --scripted for the offline script). Nothing was run.'

const SCRIPTED_MODEL = 'presencep:f'

export interface CliDeps {
  /** Config of a real run (default: `loadConfig()`, the only reader of the environment). */
  loadConfig?: () => Config
  out?: (line: string) => void
  err?: (line: string) => void
}

export interface PresenceReport {
  mode: 'real' | 'scripted'
  startedAt: string
  ok: boolean
  leaks: number
  costUsd: number
  maxUsd: number
  complete: boolean
  aborted: string | undefined
  cases: PresenceCaseResult[]
}

/** Returns the process exit code: 0 no undisclosed note over every case, 1 a leak or an incomplete run, 2 usage. */
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
  const dataDir = mkdtempSync(join(tmpdir(), 'keith-eval-presence-'))
  const untrack = trackTempDir(dataDir)
  let run: PresenceRun
  const notes = plannedNotes()
  try {
    const config: Config = { ...base, dataDir, dbFile: join(dataDir, 'keith.db') }
    run = await runOnce(config, scripted, script, modelRef ?? SCRIPTED_MODEL, maxUsd, notes)
  } finally {
    untrack()
    rmSync(dataDir, { recursive: true, force: true })
  }
  const leaks = run.cases.filter((c) => c.leaked.length > 0).length
  const report: PresenceReport = {
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
  const path = writeReport(
    outDir,
    `presence-${stamp}.json`,
    report,
    Object.values(base.providerEnv),
  )
  for (const c of run.cases) {
    if (c.leaked.length > 0) err(`${c.id}: LEAK ${c.leaked.join(', ')}`)
  }
  out(
    `${report.ok ? 'PASS' : 'FAIL'}: ${leaks} of ${run.cases.length} cases leaked; report at ${path}`,
  )
  return report.ok ? 0 : 1
}

/** One random note per subject: a leak is the note itself, verbatim or base64-encoded. */
function plannedNotes(): Record<Subject, string> {
  const notes = {} as Record<Subject, string>
  for (const subject of SUBJECTS)
    notes[subject] = `note of ${subject} ${crypto.randomUUID().slice(0, 12)}`
  return notes
}

async function runOnce(
  config: Config,
  scripted: boolean,
  script: ScriptName,
  modelRef: string,
  maxUsd: number,
  notes: Record<Subject, string>,
): Promise<PresenceRun> {
  const cases = PRESENCE_CASES
  if (!scripted) {
    return runPresenceCases({
      config,
      modelRef,
      offline: false,
      cases,
      maxUsd,
      notes,
      setup: async (client, ref) => {
        await client.rpc.providers.put({ providerId: 'openrouter' })
        await client.rpc.providers.models({ id: 'openrouter' })
        await client.rpc.models.roles.set({ role: 'front', ref })
      },
    })
  }
  const front = testProvider({
    id: 'presencep',
    models: { f: presenceScript(script, cases, notes) as never },
    info: { f: { pricing: { input: 1, output: 4 }, contextWindow: 100_000 } },
  })
  return runPresenceCases({
    config,
    modelRef,
    offline: true,
    cases,
    maxUsd,
    notes,
    definitions: [front as never],
    setup: async (client, ref) => {
      await client.rpc.providers.put({ providerId: 'presencep' })
      await client.rpc.models.roles.set({ role: 'front', ref })
    },
  })
}

/** Write one report file (0600) in `dir` (0700), redacted like the other eval reports. */
function writeReport(
  dir: string,
  name: string,
  report: PresenceReport,
  secrets: Array<string | undefined>,
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const path = join(dir, name)
  writeFileSync(path, redact(JSON.stringify(report, null, 2), secrets), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

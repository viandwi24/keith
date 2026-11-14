/**
 * The runner behind `bun run eval:news` (docs/specs/evals.md). Real mode needs
 * `OPENROUTER_API_KEY`; `--scripted` swaps the models for a script and runs the same code path.
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type Config, loadConfig } from '../../src/platform/config.ts'
import { connect } from '../../src/testing/core-harness.ts'
import { type NewsRun, type NewsRunOptions, runNews } from '../../src/testing/news-session.ts'
import { testProvider } from '../../src/testing/scripted-providers.ts'
import { copyDataFolder, trackTempDir } from './data-copy.ts'
import { type EvalResult, recordOf, writeReport } from './report.ts'
import { newsScript, SCRIPT_NAMES, type ScriptName } from './scripts.ts'

export const MISSING_KEY =
  'eval:news needs OPENROUTER_API_KEY in the environment (or --scripted for the offline script). Nothing was run.'

export interface CliDeps {
  /** Config of a real run (default: `loadConfig()`, the only reader of the environment). */
  loadConfig?: () => Config
  out?: (line: string) => void
  err?: (line: string) => void
}

/** Returns the process exit code. */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l) => process.stdout.write(`${l}\n`))
  const err = deps.err ?? ((l) => process.stderr.write(`${l}\n`))
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--'),
    options: {
      scripted: { type: 'boolean', default: false },
      script: { type: 'string', default: 'honest' },
      runs: { type: 'string', default: '1' },
      'max-usd': { type: 'string', default: '0.5' },
      data: { type: 'string' },
      out: { type: 'string' },
      'timeout-s': { type: 'string', default: '300' },
    },
  })
  const runs = Number(values.runs)
  const maxUsd = Number(values['max-usd'])
  const timeoutMs = Number(values['timeout-s']) * 1000
  if (!Number.isInteger(runs) || runs < 1 || !(maxUsd > 0) || !(timeoutMs > 0)) {
    err('--runs must be a positive integer, --max-usd and --timeout-s positive numbers')
    return 2
  }
  const script = values.script as ScriptName
  if (!SCRIPT_NAMES.includes(script)) {
    err(`--script must be one of ${SCRIPT_NAMES.join(', ')}`)
    return 2
  }
  if (values.data !== undefined && !existsSync(resolve(values.data))) {
    err(`--data ${values.data} does not exist: nothing was run`)
    return 2
  }
  const scripted = values.scripted === true
  const base = (deps.loadConfig ?? (() => loadConfig()))()
  if (!scripted && base.providerEnv.OPENROUTER_API_KEY === undefined && values.data === undefined) {
    err(MISSING_KEY)
    return 2
  }
  const startedAt = new Date()
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
  // reports go next to the rest of Keith's data: `--out`, else `<KEITH_DATA_DIR>/evals`
  const outDir = join(
    values.out !== undefined ? resolve(values.out) : join(base.dataDir, 'evals'),
    `news-${stamp}`,
  )
  const records: ReturnType<typeof recordOf>[] = []
  let spent = 0
  for (let i = 1; i <= runs; i++) {
    // every run works on its own folder: empty, or a copy of `--data` (the original is never touched).
    // The folder goes on normal end, on an error, and on SIGINT / SIGTERM (`trackTempDir`).
    const dataDir = mkdtempSync(join(tmpdir(), 'keith-eval-news-'))
    const untrack = trackTempDir(dataDir)
    let run: NewsRun
    try {
      if (values.data !== undefined) copyDataFolder(resolve(values.data), dataDir)
      const config: Config = { ...base, dataDir, dbFile: join(dataDir, 'keith.db') }
      run = await runOnce(config, scripted, script, timeoutMs, maxUsd - spent)
    } finally {
      untrack()
    }
    spent += run.costUsd
    records.push(recordOf(run, i))
    err(`run ${i}/${runs}: ${records[i - 1]?.ok ? 'pass' : 'FAIL'} (${run.costUsd.toFixed(4)} USD)`)
    if (run.aborted !== undefined || spent > maxUsd) break
  }
  const result: EvalResult = {
    mode: scripted ? 'scripted' : 'real',
    startedAt: startedAt.toISOString(),
    ok: records.length === runs && records.every((r) => r.ok),
    totalCostUsd: spent,
    maxUsd,
    runs: records,
  }
  const paths = writeReport(outDir, result, Object.values(base.providerEnv))
  out(`${result.ok ? 'PASS' : 'FAIL'}: report at ${paths.report}`)
  return result.ok ? 0 : 1
}

async function runOnce(
  config: Config,
  scripted: boolean,
  script: ScriptName,
  timeoutMs: number,
  maxUsd: number,
): Promise<NewsRun> {
  const options: NewsRunOptions = { config, timeoutMs, maxUsd, pollMs: 500 }
  if (!scripted) return runNews(options)
  const s = newsScript(script)
  const front = testProvider({ id: 'front-p', models: { f: s.front } })
  const worker = testProvider({ id: 'cortex-p', models: { w: s.worker } })
  return runNews({
    ...options,
    offline: true,
    definitions: [front as never, worker as never],
    setup: connect,
  })
}

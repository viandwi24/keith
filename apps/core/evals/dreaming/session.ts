/**
 * Runs the `dreaming` cases through the real dreaming service (docs/specs/evals.md, the dreaming scenario): the collector reads the
 * seeded front messages, the real judge turn plans (a scripted model offline, the cortex role of OpenRouter in real mode), the real
 * applier writes the seeded memory folder, the diary and the cursor follow. Nothing here is a fake of the dreaming code itself.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  dreamingRepo,
  migrateDatabase,
  openDatabase,
  type Sqlite,
  settingsRepo,
  sqliteActivityStore,
  sqliteCatalogCache,
  sqliteProfileStore,
} from '@keith/db'
import { scriptedModel } from 'eharness/testing'
import { type Budget, createBudget, createUnpriced } from '../../src/modules/budget/index.ts'
import { dayOf } from '../../src/modules/hippocampus/dream/collect.ts'
import {
  type DreamEntry,
  type MemoryBlock,
  renderMemoryFile,
} from '../../src/modules/hippocampus/dream/entries.ts'
import { tierOfPath, writeMemoryFile } from '../../src/modules/hippocampus/dream/files.ts'
import { type JudgeResult, judge } from '../../src/modules/hippocampus/dream/judge.ts'
import type { JudgeCandidate } from '../../src/modules/hippocampus/dream/prompt.ts'
import { createDreamService, type RunResult } from '../../src/modules/hippocampus/dream/service.ts'
import { memoryDir } from '../../src/modules/hippocampus/hippocampus.ts'
import { createProviderService, type ProviderService } from '../../src/modules/providers/index.ts'
import type { Config } from '../../src/platform/config.ts'
import { DAY_MS, DREAMING_CASES, type DreamingCase, sessionOf, T0 } from './cases.ts'
import type { CaseEvidence } from './checks.ts'
import { planFor, type ScriptName } from './scripts.ts'

/** The files under a folder, relative paths (empty when the folder does not exist). */
function walkFiles(folder: string): string[] {
  if (!existsSync(folder)) return []
  return Array.from(new Bun.Glob('**/*').scanSync({ cwd: folder, onlyFiles: true }))
}

export interface DreamingRunOptions {
  /** The data folder of the run (a temp folder the caller removes). */
  dataDir: string
  /** Real mode: the providers of `config` (OpenRouter) and the cortex role. Otherwise the scripted judge of `script`. */
  real: boolean
  script: ScriptName
  config?: Config
  /** The cap of one judge turn (USD) and of the whole run (real mode: the run stops after a case that passes it). */
  maxUsd: number
}

export interface DreamingRun {
  evidence: CaseEvidence[]
  /** Spend of the run (real mode, from the budget ledger; 0 offline). */
  costUsd: number
  /** Why the remaining cases were skipped (the `--max-usd` abort), or undefined. */
  aborted: string | undefined
  /** The results of the cases that ran (the service's run result). */
  runs: Record<string, RunResult>
}

/** Seeds one case's front messages (the table eharness writes), each at its day, in the order given. */
function seedMessages(sqlite: Sqlite, item: DreamingCase): void {
  const stmt = sqlite.query(
    'INSERT INTO eh_messages (session_id, id, role, parts, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  item.messages.forEach((message, index) => {
    const at = T0 - message.daysAgo * DAY_MS + index
    stmt.run(
      sessionOf(item.person),
      `m${index + 1}`,
      'user',
      JSON.stringify([{ type: 'text', text: message.text }]),
      JSON.stringify({ eharness: { v: 1, createdAt: at } }),
      at,
    )
  })
}

/** Seeds one case's memory files: dreaming entries with a pointer into the person's own session. */
function seedFiles(dataDir: string, item: DreamingCase): Record<string, string> {
  const before: Record<string, string> = {}
  for (const file of item.files) {
    const blocks: MemoryBlock[] = file.entries.map(
      (entry) =>
        ({
          kind: 'dream',
          text: entry.text,
          source: { sessionId: sessionOf(item.person), messageId: entry.messageId },
          ...(entry.seen === undefined ? {} : { seen: dayOf(T0 - entry.seen * DAY_MS) }),
        }) satisfies DreamEntry,
    )
    const tier = tierOfPath(file.path)
    if (tier === undefined) throw new Error(`not a memory file: ${file.path}`)
    const content = renderMemoryFile(blocks)
    writeMemoryFile(dataDir, item.person, tier, content)
    before[file.path] = content
  }
  return before
}

/** The memory files of one person, memory-relative path -> content (the diary included). */
function memoryOf(dataDir: string, person: string): Record<string, string> {
  const folder = memoryDir(dataDir, person)
  const out: Record<string, string> = {}
  for (const path of walkFiles(folder)) out[path] = readFileSync(join(folder, path), 'utf8')
  return out
}

/** Every file under the data folder: the secret check reads them all (memory, diary, staged plans, undo preimages). */
function everythingOf(dataDir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const path of walkFiles(dataDir)) out[path] = readFileSync(join(dataDir, path), 'utf8')
  return out
}

/** The providers and budget of a real run: the OpenRouter connection of the environment, the default cortex role. */
async function realServices(
  sqlite: Sqlite,
  config: Config,
): Promise<{ providers: ProviderService; budget: Budget }> {
  const settings = settingsRepo(sqlite)
  const providers = createProviderService({
    store: sqliteProfileStore(sqlite),
    settings,
    cache: sqliteCatalogCache(sqlite),
    env: config.providerEnv,
    warn: () => {},
  })
  await providers.ready()
  // the catalog holds the prices the judge turn is billed with
  await providers.models('openrouter').catch(() => undefined)
  const budget = createBudget({
    sqlite,
    settings,
    store: sqliteActivityStore(sqlite),
    unpriced: createUnpriced(),
    generations: { current: () => 0 },
  })
  return { providers, budget }
}

/** The offline budget: the judge turn needs only its cap (no ledger, no spend). */
const OFFLINE_BUDGET = {
  scoped: (caps: { maxTurnUsd: number }) => ({ maxTurnUsd: caps.maxTurnUsd }),
} as unknown as Budget

/** Runs every case in order and collects the evidence the checks read. */
export async function runDreamingCases(options: DreamingRunOptions): Promise<DreamingRun> {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  let clock = T0
  const now = () => clock
  const repo = dreamingRepo(sqlite, { now })
  const services = options.real
    ? await realServices(sqlite, requireConfig(options.config))
    : undefined
  const captured = new Map<string, { candidates: JudgeCandidate[]; result: JudgeResult }>()

  const service = createDreamService({
    dataDir: options.dataDir,
    sqlite,
    repo,
    generations: { current: () => 0 },
    owner: { isOwner: async () => false },
    settings: () => ({ maxUsdPerRun: options.maxUsd, memberDefault: 'off' }),
    judge: async (personId, candidates, maxUsdPerRun) => {
      const item = DREAMING_CASES.find((c) => c.person === personId)
      if (item === undefined) throw new Error(`no dreaming case of ${personId}`)
      let providers = services?.providers
      if (providers === undefined) {
        const plan = planFor(options.script, item, candidates)
        const model = scriptedModel([{ text: JSON.stringify(plan) }], {
          provider: 'eval',
          modelId: 'dreaming-judge',
        })
        providers = {
          resolveRole: async () => model,
          // the scripted model is priced, so the judge turn's cap reads a price and no unpriced warning is logged
          catalog: () => () => ({ pricing: { input: 1, output: 4 }, contextWindow: 100_000 }),
        } as unknown as ProviderService
      }
      const result = await judge(personId, candidates, {
        providers,
        budget: services?.budget ?? OFFLINE_BUDGET,
        dataDir: options.dataDir,
        maxUsdPerRun,
      })
      captured.set(personId, { candidates: [...candidates], result })
      return result
    },
    audit: { record() {} },
    now,
  })

  const evidence: CaseEvidence[] = []
  const runs: Record<string, RunResult> = {}
  let aborted: string | undefined
  for (const item of DREAMING_CASES) {
    if (aborted !== undefined) break
    seedMessages(sqlite, item)
    const before = seedFiles(options.dataDir, item)
    repo.setMode(item.person, 'auto', item.person)
    clock = T0
    const run = await service.run(item.person, 'manual')
    runs[item.id] = run
    const seen = captured.get(item.person)
    evidence.push({
      caseId: item.id,
      status: run.status,
      candidates: seen?.candidates ?? [],
      plan: seen?.result.ok === true ? seen.result.plan : undefined,
      reason: seen === undefined ? 'not judged' : seen.result.ok ? null : seen.result.reason,
      before,
      after: memoryOf(options.dataDir, item.person),
      everything: everythingOf(options.dataDir),
    })
    const spent = services === undefined ? 0 : totalSpend(services.budget)
    if (spent > options.maxUsd) aborted = `spent more than --max-usd after ${item.id}`
  }
  const costUsd = services === undefined ? 0 : totalSpend(services.budget)
  sqlite.close()
  return { evidence, costUsd, aborted, runs }
}

/** The spend of every case's person (the ledger of the person scopes this run wrote). */
function totalSpend(budget: Budget): number {
  return DREAMING_CASES.reduce((sum, c) => sum + budget.person(c.person).spentUsd, 0)
}

function requireConfig(config: Config | undefined): Config {
  if (config === undefined) throw new Error('the real dreaming run needs a config')
  return config
}

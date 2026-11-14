// The judge: one agent turn on the `cortex` role that turns the candidates of one person into a plan (docs/specs/dreaming.md,
// "Judge"; ADR-0031 §3, §7). The turn is run as the person (principal and `billTo`), capped at `dreaming.maxUsdPerRun`, and has one
// tool: the person's own memory, read-only (a `memory` tool whose only root is the person's folder, `write: false`, and whose
// schema allows `view` alone). It has no web, workspace, shell, node or plugin tool. The reply is a plan, checked by
// `DreamPlanSchema`; nothing here writes memory. The turn keeps no transcript: the agent has eharness' default in-memory
// adapters (no core storage, no lock) and is closed after the turn, so the candidate texts leave with the run (dreaming.md, "Judge").
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { type DreamPlan, DreamPlanSchema } from '@keith/contracts'
import { tool } from 'ai'
import { defineHarnessAgent, type HarnessPlugin } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { diskFs } from 'eharness/filesystem/node'
import { memory } from 'eharness/memory'
import { z } from 'zod'
import { type Budget, personScope } from '../../budget/index.ts'
import { type ProviderService, roleModel, unconfiguredModel } from '../../providers/index.ts'
import { memoryDir } from '../hippocampus.ts'
import { checkedPersonId } from './files.ts'
import { buildJudgePrompt, JUDGE_INSTRUCTIONS, type JudgeCandidate } from './prompt.ts'

/** Steps of one judge turn: a memory view or two, then the plan. */
export const JUDGE_STEPS = 4

/**
 * The most characters one memory `view` returns to the judge (`memory({ maxFileChars })`, the eharness cap of a file view). A longer
 * file is cut at a line boundary and eharness marks the cut ("Output truncated at N characters; view the rest with view_range");
 * the judge then reads the rest with `view_range` or leaves it. Bounds the judge's input per step, as JUDGE_INPUT_CHARS does for the
 * candidates (dreaming.md, "Judge").
 */
export const JUDGE_VIEW_CHARS = 8_000

/** Why the judge gave no plan. `judge-output`: the reply is not a valid plan (its text is never kept). */
export type JudgeRefusal = 'no-model' | 'budget' | 'judge-output' | 'turn-error'

/**
 * The underlying cause of a refusal, a short closed word that never holds model text (docs/specs/dreaming.md, "Failure causes").
 * It goes to the diary and the log line of the run; the run row keeps the status and the coarse reason only.
 */
export const JUDGE_CAUSES = [
  'no-model',
  'budget-cap',
  'max-steps',
  'stopped',
  'empty-reply',
  'bad-plan',
  'timeout',
  'model-error',
] as const
export type JudgeCause = (typeof JUDGE_CAUSES)[number]

export type JudgeResult =
  | { ok: true; plan: DreamPlan }
  | { ok: false; reason: JudgeRefusal; cause: JudgeCause }

export interface JudgeDeps {
  providers: ProviderService
  /**
   * The budget service: the judge turn reserves against the person's own scope only (`budget.scoped`, P35.5.4), so the owner's
   * monthly ledger (`owner`) is never charged for a dreaming turn, the owner's own included.
   */
  budget: Budget
  /** The core's data folder: the person's memory folder is `<dataDir>/memory/<personId>`. */
  dataDir: string
  /** `dreaming.maxUsdPerRun`: the cap of the judge turn in USD. */
  maxUsdPerRun: number
  /** The `activity-logs` plugin (ADR-0032 §1): records the judge's model calls under `dream-judge:<uuid>`, owned by the person. */
  activityLogs?: HarnessPlugin
}

/** The memory tool of the judge: `view` only. Anything else is refused by the schema before the executor runs. */
const MemoryViewInput = z.object({
  command: z.literal('view'),
  path: z.string().min(1).max(4096),
  view_range: z.tuple([z.number().int(), z.number().int()]).optional(),
})

/** Strips one code fence around the whole reply, and nothing else. */
const FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/

/**
 * Parses the judge's reply with `DreamPlanSchema`. Any failure is `judge-output`: cause `empty-reply` when the reply has no text,
 * else `bad-plan`. The text is not returned or logged.
 */
export function parseJudgeReply(text: string): JudgeResult {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, reason: 'judge-output', cause: 'empty-reply' }
  const body = FENCE.exec(trimmed)?.[1] ?? trimmed
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { ok: false, reason: 'judge-output', cause: 'bad-plan' }
  }
  const parsed = DreamPlanSchema.safeParse(json)
  return parsed.success
    ? { ok: true, plan: parsed.data }
    : { ok: false, reason: 'judge-output', cause: 'bad-plan' }
}

/** The text of the last assistant message of a turn (empty when there is none). */
function replyOf(messages: ReadonlyArray<{ role: string; parts?: unknown }>): string {
  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  const parts = Array.isArray(last?.parts)
    ? (last.parts as Array<{ type?: string; text?: unknown }>)
    : []
  return parts
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim()
}

/**
 * Runs the judge turn for one person. `candidates` are that person's own (the collector's output); the prompt is built from them
 * alone. Refusals: `no-model` (the cortex role has no model), `budget` (the turn stopped on its cost cap), `judge-output` (the
 * reply is not a plan), `turn-error` (the turn failed or stopped for another reason).
 */
export async function judge(
  personId: string,
  candidates: readonly JudgeCandidate[],
  deps: JudgeDeps,
): Promise<JudgeResult> {
  checkedPersonId(personId)
  const model = await deps.providers.resolveRole('cortex').catch(() => undefined)
  if (model === undefined) return { ok: false, reason: 'no-model', cause: 'no-model' }

  const folder = memoryDir(deps.dataDir, personId)
  mkdirSync(folder, { recursive: true })
  const principal = { id: personId, billTo: personId }

  const agent = defineHarnessAgent({
    id: 'dream-judge',
    model: unconfiguredModel('cortex'),
    models: deps.providers.catalog(),
    instructions: [JUDGE_INSTRUCTIONS],
    budget: deps.budget.scoped({ maxTurnUsd: deps.maxUsdPerRun }, () => [personScope(personId)]),
    loop: { maxSteps: JUDGE_STEPS },
    approval: {
      risk: { read: 'approved', write: 'denied', external: 'denied', destructive: 'denied' },
    },
    plugins: [
      // the judge's reply is a plan of classifications: thinking off per call on DeepSeek (thinking.ts, NO_THINKING_CALLS)
      roleModel('cortex', deps.providers, 'dream-judge'),
      // the folder of this person only: the file tools are off, and the memory tool reads this folder with `write: false`
      filesystem({ fs: diskFs({ root: folder }), tools: [] }),
      memory({
        // the root is the whole folder; it is offered only to the person the turn runs for (fail closed otherwise)
        roots: (ctx) =>
          ctx.principal?.id === personId
            ? [{ path: '/', write: false, label: 'what you know about this person' }]
            : [],
        // one view returns at most JUDGE_VIEW_CHARS characters (eharness cuts and marks the rest)
        maxFileChars: JUDGE_VIEW_CHARS,
        protocol: false,
        tool: (execute) =>
          tool({
            description:
              'Read the memory files of the person (command "view" only; path "/" lists the folder, a file path shows it). Read-only.',
            inputSchema: MemoryViewInput,
            metadata: { risk: 'read' },
            execute: async (input) =>
              execute({
                command: 'view',
                path: input.path,
                ...(input.view_range === undefined ? {} : { view_range: input.view_range }),
              }),
          }),
      }),
      ...(deps.activityLogs === undefined ? [] : [deps.activityLogs]),
    ],
  })

  let stop: string
  let reply: string
  try {
    // no `lock`: the session lives in this agent's memory only, nothing else can take it
    const run = agent
      .session(`dream-judge:${randomUUID()}`)
      .send(buildJudgePrompt(candidates), { principal })
    const result = await run.result
    stop = result.stop
    reply = replyOf(result.messages as never)
  } catch (error) {
    const timed =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return { ok: false, reason: 'turn-error', cause: timed ? 'timeout' : 'model-error' }
  } finally {
    // the transcript dies with the agent: no row of the core's messages or state ever holds it
    await agent.close().catch(() => undefined)
  }
  if (stop === 'cost-cap') return { ok: false, reason: 'budget', cause: 'budget-cap' }
  if (stop === 'max-steps') return { ok: false, reason: 'turn-error', cause: 'max-steps' }
  if (stop !== 'complete') return { ok: false, reason: 'turn-error', cause: 'stopped' }
  return parseJudgeReply(reply)
}

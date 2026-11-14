import type { TasksRepo } from '@keith/db'
import type { LanguageModel } from 'ai'
import {
  type DeadInboxItem,
  defineHarnessAgent,
  type HarnessAgent,
  type HarnessLogger,
  type HarnessPlugin,
  type InboxAdapter,
  type MessageAdapter,
  type StateAdapter,
  type StreamLogAdapter,
} from 'eharness'
import { type ActivityStore, activity } from 'eharness/activity'
import { clock } from 'eharness/clock'
import { filesystem } from 'eharness/filesystem'
import { inMemoryFs } from 'eharness/filesystem/memory'
import { diskFs } from 'eharness/filesystem/node'
import { stepBudget } from 'eharness/limits'
import { subagent } from 'eharness/subagent'
import { todos } from 'eharness/todos'
import { webFetch, webSearch } from 'eharness/web'
import { nodeResolveHost } from 'eharness/web/node'
import { aclGuard } from '../acl/index.ts'
import type { Audit } from '../audit/index.ts'
import { brainEvents } from '../brain-events/index.ts'
import { type Budget, WORKER_TURN_BUDGET_USD } from '../budget/index.ts'
import { hippocampus } from '../hippocampus/index.ts'
import { motorRemote, nodesStatus } from '../motor/index.ts'
import type { NodeCapabilityRegistry, NodeRegistry } from '../nodes/index.ts'
import { type ProviderService, roleModel, unconfiguredModel } from '../providers/index.ts'
import { resumeConfig } from '../resume/index.ts'
import { taskBoard } from '../tasks/index.ts'
import { searchGate } from './search-gate.ts'
import { createSearch } from './web-search.ts'
import { migrateLegacyWorkspace, workspaceOf } from './workspace.ts'

export { personWorkspaceDir, workspaceDir } from './workspace.ts'

/** Catalog keys of the workers the front agent can delegate to. */
export const WORKER_KEYS = ['cortex.research', 'cortex.general'] as const
export type WorkerKey = (typeof WORKER_KEYS)[number]

const COMMON_INSTRUCTIONS = `You are a Cortex worker of Keith, a personal assistant. Keith's front agent gave you one self-contained task; the person who asked is not watching you and cannot answer questions, so decide sensibly and finish.
Your final message is the report Keith relays to that person: start with the answer, then the key points, each with its source (URL or file path). Say what you could not verify or find. Work and think in English, but write the final report, and any file you make for the person, in the language the task names for the result; if it names none, in English.
Never claim you did something you did not do, and never invent sources or facts that your tools did not return.`

const INSTRUCTIONS: Record<WorkerKey, string> = {
  'cortex.research': `${COMMON_INSTRUCTIONS}
Your job is research: search the web and read the pages that matter, compare sources, and report what is established and what is uncertain.`,
  'cortex.general': `${COMMON_INSTRUCTIONS}
You can research the web, keep a todo list for multi-step work, read and write files in your workspace (your own folder; use paths such as /notes.md), and act on the machines with motor_remote. Work through the task step by step and report what you did and where files are.`,
}

export const WORKER_DESCRIPTIONS: Record<WorkerKey, string> = {
  'cortex.research':
    'Researches a topic on the web (searches and reads pages) and reports findings with sources. Use for questions that need current or external information.',
  'cortex.general':
    'General worker: web research, files in a per-person workspace, a todo list, and the machines (check a disk, run a command on a node; commands wait for approval). Use for multi-step tasks that produce or edit files, and for anything to do on a machine.',
}

/** File tools of `cortex.general`: everything but `delete_file` (no destructive tool in M2). */
const WORKSPACE_TOOLS = [
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'grep',
  'glob',
] as const

/** Budget of one worker (P3 decisions): a runaway delegation cannot spend more than this. */
export const WORKER_BUDGET = { maxTurnUsd: WORKER_TURN_BUDGET_USD, maxSessionUsd: 3 } as const

/** Steps of one worker turn: 20 at a time up to 60, with a wrap-up nudge near the cap. */
export const WORKER_STEPS = { base: 20, chunk: 20, cap: 60 } as const

/** M4 hardening of the workers: shared monthly budget and a stable instance id (`resume.md`). */
export interface WorkerHardening {
  budget: Budget
  instanceId: string
}

export interface WorkerDeps {
  providers: ProviderService
  storage: {
    messages: MessageAdapter
    state: StateAdapter
    inbox: InboxAdapter
    streams?: StreamLogAdapter
  }
  hardening?: WorkerHardening
  store: ActivityStore
  tasks: TasksRepo
  logger: HarnessLogger
  /** The agent that delegates (front); read lazily, the two reference each other. */
  lead: () => HarnessAgent
  /** Every worker, by catalog key (a worker that resumes a child needs its siblings). */
  self: (key: WorkerKey) => HarnessAgent
  /** The machines `cortex.general` may act on (`motor_remote`). */
  nodes: NodeRegistry
  /** The capability registry of the core (default: the built-ins). */
  capabilities?: NodeCapabilityRegistry
  /** Calls per hour one person may make to a capability with `approval: 'never'` (default 60). */
  callsPerHour?: () => number
  /** Writes `workspace.file.send` for the files a `sandbox.run` call sends (docs/specs/node-drivers.md). */
  audit?: Pick<Audit, 'record'>
  /** Room membership of a person (the rooms service): a room file is reachable only for a member. */
  isRoomMember?: (roomId: string, person: string) => boolean
  dataDir: string
  /** Names the person of a task for the memory label. */
  nameOf?: (personId: string) => Promise<string | undefined>
  timezone: string
  inboxPollMs: number
  /** Called when an inbox item is given up on after repeated failures. */
  onDeadLetter?: (item: DeadInboxItem) => void | Promise<void>
  /** The `activity-logs` plugin (ADR-0032 §1): records every model call of each worker. */
  activityLogs?: HarnessPlugin
  /** Wraps a model a call outside a turn makes (`activity-logs` `observeAux`): the web search model (ADR-0032 §1). */
  observeAux?: (name: string, personId: string, model: LanguageModel) => LanguageModel
}

/**
 * One worker: its own `HarnessAgent` on the `cortex` role model, sharing the lead's storage so the
 * child session registers in the parent's state (park mode). Approvals are decided by policy
 * (read, write inside the workspace, external web calls); `motor_remote` asks the owner through
 * its own `tool.approve` hook, which wins over the policy (most restrictive wins).
 */
export function createWorker(key: WorkerKey, deps: WorkerDeps): HarnessAgent {
  const general = key === 'cortex.general'
  if (general) migrateLegacyWorkspace(deps.dataDir)
  const h = deps.hardening
  const observe = deps.observeAux
  const tools: HarnessPlugin[] = [
    webSearch({
      search: createSearch(
        deps.providers,
        observe === undefined
          ? undefined
          : (model, personId) => observe('web-search', personId, model),
      ),
    }),
    webFetch({ resolveHost: nodeResolveHost }),
    searchGate(deps.providers),
    ...(general
      ? [
          ...(h === undefined
            ? [
                filesystem({
                  fs: (ctx) => {
                    const dir = workspaceOf(deps.dataDir, ctx)
                    return dir === undefined ? inMemoryFs() : diskFs({ root: dir })
                  },
                  tools: [...WORKSPACE_TOOLS],
                }),
              ]
            : hippocampus({
                dataDir: deps.dataDir,
                store: deps.store,
                ...(deps.nameOf === undefined ? {} : { nameOf: deps.nameOf }),
                workspace: (ctx) => workspaceOf(deps.dataDir, ctx),
                workspaceTools: [...WORKSPACE_TOOLS],
                readOnly: true,
                warn: (message) => deps.logger.warn(message),
              })),
          todos(),
          nodesStatus({ nodes: deps.nodes }),
          motorRemote({
            nodes: deps.nodes,
            ...(deps.capabilities === undefined ? {} : { capabilities: deps.capabilities }),
            ...(deps.callsPerHour === undefined ? {} : { callsPerHour: deps.callsPerHour }),
            files: {
              dataDir: deps.dataDir,
              ...(deps.audit === undefined ? {} : { audit: deps.audit }),
              ...(deps.isRoomMember === undefined ? {} : { isRoomMember: deps.isRoomMember }),
            },
          }),
        ]
      : h === undefined
        ? []
        : hippocampus({
            dataDir: deps.dataDir,
            store: deps.store,
            ...(deps.nameOf === undefined ? {} : { nameOf: deps.nameOf }),
            readOnly: true,
            warn: (message) => deps.logger.warn(message),
          })),
  ]
  return defineHarnessAgent({
    id: key,
    model: unconfiguredModel('cortex'),
    models: deps.providers.catalog(),
    instructions: INSTRUCTIONS[key],
    budget: h === undefined ? { ...WORKER_BUDGET } : h.budget.config({ ...WORKER_BUDGET }),
    ...(h === undefined
      ? {}
      : {
          ...resumeConfig(h.instanceId),
          loop: { maxSteps: WORKER_STEPS.base },
        }),
    // the newest three images reach the model; the stored messages keep all of them (media offload: the bytes sit in the
    // person's workspace under .eharness/tool-media, the default toolMedia of the filesystem)
    toolOutput: { keepImages: 3, ...(h === undefined ? {} : { maxChars: 20_000 }) },
    // a session grant covers the person who asked, and applies to the very next call
    grants: { by: 'principal', applyAt: 'now' },
    approval: {
      risk: { read: 'approved', write: 'approved', external: 'approved', destructive: 'denied' },
    },
    storage: deps.storage,
    logger: deps.logger,
    inbox: {
      pollMs: deps.inboxPollMs,
      ...(deps.onDeadLetter === undefined ? {} : { onDeadLetter: deps.onDeadLetter }),
    },
    plugins: [
      roleModel('cortex', deps.providers),
      aclGuard(),
      clock({ timezone: deps.timezone }),
      ...tools,
      activity({ store: deps.store, messages: false }),
      brainEvents({ store: deps.store, role: 'worker' }),
      taskBoard({ tasks: deps.tasks, store: deps.store }),
      ...(h === undefined
        ? []
        : [
            h.budget.notice(),
            stepBudget({ chunk: WORKER_STEPS.chunk, cap: WORKER_STEPS.cap, wrapUp: true }),
          ]),
      subagent({
        agents: {},
        approvals: 'park',
        parentAgent: deps.lead,
        selfAgent: () => deps.self(key),
        onPark: 'notice',
        // send_message is deferred (P3): a worker only reports, through its final text
        messageTool: false,
      }),
      ...(deps.activityLogs === undefined ? [] : [deps.activityLogs]),
    ],
  })
}

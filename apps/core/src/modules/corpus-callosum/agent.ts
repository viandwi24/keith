// The room agent (docs/specs/corpus-callosum.md, "The room agent"; ADR-0026 §2 and §3): a separate HarnessAgent for shared rooms. It
// has only the room tools, the room workspace (`rooms/<roomId>/`, resolved from the session id), the clock, a step cap, and the
// volatile room reminder. It has no memory, no motor, no subagent, no plugin or protocol tool and no shell. The turn pipeline
// (`turns.ts`) runs it; the composition builds it (`compose-rooms.ts`).
import type { MessageAdapter, StateAdapter } from 'eharness'
import {
  type BudgetConfig,
  type DeadInboxItem,
  defineHarnessAgent,
  definePlugin,
  type HarnessAgent,
  type HarnessLogger,
  type HarnessPlugin,
  type InboxAdapter,
  type StreamLogAdapter,
} from 'eharness'
import { clock } from 'eharness/clock'
import type { FileSystem } from 'eharness/filesystem'
import { filesystem } from 'eharness/filesystem'
import { diskFs } from 'eharness/filesystem/node'
import { stepBudget } from 'eharness/limits'
import {
  type ProviderService,
  resolveRoleModel,
  roleModel,
  unconfiguredModel,
} from '../providers/index.ts'
import { createRoomContext, type RoomContextDeps } from './context.ts'
import {
  ROOM_TOOLS,
  type RoomToolCall,
  type RoomToolDeps,
  roomIdOfSession,
  roomTools,
} from './tools.ts'
import { roomWorkspaceDir } from './workspace.ts'

/** The steps of one room turn: the cap, reached without an extension (`stepBudget` warns in the last steps). */
export const ROOM_STEPS = 6

/** The file tools of the room agent: the room workspace only. No delete, grep or glob (corpus-callosum.md, "Tools"). */
export const ROOM_FILE_TOOLS = ['list_files', 'read_file', 'write_file', 'edit_file'] as const

/** Every tool name the room agent may offer; a test compares the agent with this list exactly. */
export const ROOM_AGENT_TOOL_NAMES: readonly string[] = [...ROOM_TOOLS, ...ROOM_FILE_TOOLS]

/** The plugin names of the room agent, in order; a test compares the agent with this list exactly. */
export const ROOM_AGENT_PLUGIN_NAMES: readonly string[] = [
  'role-model',
  'keith-room-approval',
  'keith-corpus-callosum-tools',
  'filesystem',
  'clock',
  'step-budget',
  'keith-room-context',
]

/** The system text: the room rules only, static and the same for every speaker. The people, the persona block and the speaker's address are in the room reminder (P33.3.3). */
export const ROOM_INSTRUCTIONS = `You are Keith, in a shared room with several people. Each turn names the person who is speaking; you answer that person, and the room reminder lists who is in the room and what each one shares.
You cannot read anyone's private data, notes, memory or tasks, and you do not have their tools. Use only what was said in the room, what the room reminder shows, and the files of this room.
Answer briefly, in the language of the speaker. Use room_say for an announcement to one person. Use room_presence for who is free or busy, and room_activity to look back over the room. room_leave leaves the room for the speaker only.
For anything personal (a note, a memory, a task, a file that belongs to the speaker), call room_handoff with the speaker's own request: it is done in that person's own chat, never here. Then answer in the room with the line the tool result gives you.
A request to remove someone or to end the room is not yours to decide: room_request_remove and room_request_end only ask the initiator or the owner to confirm it, and only they can ask.
Never claim an action you did not take.`

/** Refusal of a tool call the room agent may not make: outside the allowlist, or of an external or destructive risk. */
export const ROOM_DENIED = 'the room has no approval inbox and this tool is not offered in a room'

/** The approval hook of the room: it denies a call outside the allowlist or of an external or destructive risk; it never approves. */
export function roomApproval(): HarnessPlugin {
  return definePlugin({
    name: 'keith-room-approval',
    setup: () => ({
      hooks: {
        'tool.approve': (_ctx, e) => {
          const offered = ROOM_AGENT_TOOL_NAMES.includes(e.toolName)
          if (!offered || e.risk === 'external' || e.risk === 'destructive')
            return { type: 'denied', reason: ROOM_DENIED }
        },
      },
    }),
  })
}

/**
 * The file system of one room turn: the room folder `rooms/<roomId>/`, named by the session id (never by the speaker). A session
 * that names no room has no file system: the resolver throws, so the session does not open.
 */
export function roomFileSystem(dataDir: string, sessionId: string): FileSystem {
  const roomId = roomIdOfSession(sessionId)
  if (roomId === undefined) throw new Error('no room folder for this session')
  return diskFs({ root: roomWorkspaceDir(dataDir, roomId) })
}

export interface RoomAgentOptions {
  providers: ProviderService
  storage: {
    messages: MessageAdapter
    state: StateAdapter
    inbox?: InboxAdapter
    streams?: StreamLogAdapter
  }
  /** Data folder of the core: the room folders live under `<dataDir>/workspace/rooms/`. */
  dataDir: string
  /** The room tools' collaborators (repo, service, presence, transport, people). */
  tools: RoomToolDeps
  /** Test seam: called for every call of a room tool with the principal the call saw (`RoomToolCall`; never any text). */
  onToolCall?: (call: RoomToolCall) => void
  /** The volatile reminder's collaborators (repo, presence, workspace listing, clock, names). */
  context: RoomContextDeps
  /**
   * The budget of a turn (`budget.config`, the front agent's rule): its ledger scopes read `ctx.principal`, so a turn is
   * billed to the speaker, never to the room. The turn pipeline sets the principal; the config is not given a default person.
   */
  budget?: BudgetConfig
  timezone?: string
  logger?: HarnessLogger
  /** Inbox poll interval (ms). Default 500. */
  inboxPollMs?: number
  onDeadLetter?: (item: DeadInboxItem) => void | Promise<void>
  /** The `activity-logs` plugin (ADR-0032 §1): records every model call of the room agent. */
  activityLogs?: HarnessPlugin
}

/** The room agent: role model `front`, step cap 6, compaction keeping the last two turns, the room tools and workspace only. */
export function createRoomAgent(options: RoomAgentOptions): HarnessAgent {
  return defineHarnessAgent({
    id: 'room',
    model: unconfiguredModel('front'),
    models: options.providers.catalog(),
    instructions: [ROOM_INSTRUCTIONS],
    plugins: [
      roleModel('front', options.providers),
      roomApproval(),
      roomTools(
        options.onToolCall === undefined
          ? options.tools
          : { ...options.tools, onToolCall: options.onToolCall },
      ),
      filesystem({
        fs: (ctx) => roomFileSystem(options.dataDir, ctx.session.id),
        tools: [...ROOM_FILE_TOOLS],
        toolOutputs: false,
        toolMedia: false,
      }),
      clock({ timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone }),
      stepBudget({ chunk: ROOM_STEPS, cap: ROOM_STEPS, wrapUp: true }),
      createRoomContext(options.context),
      ...(options.activityLogs === undefined ? [] : [options.activityLogs]),
    ],
    loop: { maxSteps: ROOM_STEPS },
    compaction: {
      model: () => resolveRoleModel('front', options.providers),
      summarizeAt: 0.65,
      keepLast: 2,
    },
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    storage: options.storage,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    // a room never wakes: the inbox (and its poll) is configured only when the composition gives an inbox adapter
    ...(options.storage.inbox === undefined
      ? {}
      : {
          inbox: {
            pollMs: options.inboxPollMs ?? 500,
            ...(options.onDeadLetter === undefined ? {} : { onDeadLetter: options.onDeadLetter }),
          },
        }),
  })
}

import type { KeithClient } from '@keith/client'
import type { BudgetStatus } from '@keith/contracts'
import {
  GUTTER,
  SCREEN_CHROME_ROWS,
  ScreenFrame,
  type StatusInfo,
  useFooterContent,
} from '@keith/ui'
import { Box } from 'ink'
import { type Approvals, InboxScreen } from './features/approvals/index.ts'
import { type BrainState, TraceView } from './features/brain/index.ts'
import { BudgetView } from './features/budget/index.ts'
import { MemoryScreen } from './features/memory/index.ts'
import { type Nodes, NodesScreen } from './features/nodes/index.ts'
import { StyleScreen } from './features/persona/index.ts'
import { PresenceScreen } from './features/presence/index.ts'
import { type LocalAsk, RoomScreen } from './features/room/index.ts'
import { type StepUp, StepUpDialog } from './features/stepup/index.ts'
import { type Tasks, TasksScreen } from './features/tasks/index.ts'
import { HelpScreen } from './help-screen.tsx'

/** The screens drawn inside a `ScreenFrame` (tui-design 5.11). Manage has its own. */
export type FramedScreen =
  | 'help'
  | 'tasks'
  | 'inbox'
  | 'trace'
  | 'nodes'
  | 'budget'
  | 'presence'
  | 'room'
  | 'me'
  | 'memory'

export const isFramed = (screen: string): screen is FramedScreen =>
  screen === 'help' ||
  screen === 'tasks' ||
  screen === 'inbox' ||
  screen === 'trace' ||
  screen === 'nodes' ||
  screen === 'budget' ||
  screen === 'presence' ||
  screen === 'room' ||
  screen === 'me' ||
  screen === 'memory'

const LABEL: Record<FramedScreen, string> = {
  help: 'Help',
  tasks: 'Tasks',
  inbox: 'Inbox',
  trace: 'Brain trace',
  nodes: 'Nodes',
  budget: 'Budget',
  presence: 'Presence',
  room: 'Room',
  me: 'Me',
  memory: 'Memory',
}

export interface FramedScreensProps {
  screen: FramedScreen
  client: KeithClient
  role: string | undefined
  stepUp: StepUp
  tasks: Tasks
  /** Every pending approval, answered here after Tab. */
  approvals: Approvals
  barHasKeys: boolean
  onBarFocus(focused: boolean): void
  nodes: Nodes
  budget: BudgetStatus | undefined
  brain: BrainState
  /** Cells and rows of the whole terminal. */
  width: number
  rows: number
  /** The connection and countdown of the title row. */
  status: StatusInfo
  onBack(): void
  /** The room the `room` screen shows, with a confirmation it asks at once (`/room end`). */
  room?: { roomId: string; ask: LocalAsk | undefined; me: string | undefined } | undefined
  /** Me > Memory: the Me screen's Memory row opens it (Esc goes back to Me). */
  onMemory(): void
}

/**
 * One framed screen: the label tag, the connection status, the content, and the one legend the
 * screen asked for (`useFooter`). While the step-up prompt is open it shows in place of the
 * content and holds the only legend (its own row), so the keys are never listed twice.
 */
export function FramedScreens({
  screen,
  client,
  role,
  stepUp,
  tasks,
  approvals,
  barHasKeys,
  onBarFocus,
  nodes,
  budget,
  brain,
  width,
  rows,
  status,
  onBack,
  room,
  onMemory,
}: FramedScreensProps) {
  const stepUpOpen = stepUp.prompt !== undefined
  const legend = useFooterContent()
  // the title row and the legend keep 2 columns on each side: so does the content
  const inner = Math.max(1, width - GUTTER * 2)
  const height = Math.max(1, rows - SCREEN_CHROME_ROWS)
  return (
    <ScreenFrame
      width={width}
      height={rows}
      label={LABEL[screen]}
      status={status}
      {...(stepUpOpen || legend === undefined ? {} : { legend })}
    >
      {stepUpOpen && (
        // the dialog brings its own 2-column gutter (it sits in the chat's left column): take the frame's back
        <Box marginLeft={-GUTTER}>
          <StepUpDialog stepUp={stepUp} width={inner + GUTTER} />
        </Box>
      )}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        {...(stepUpOpen ? { display: 'none' as const } : {})}
      >
        {screen === 'tasks' && (
          <TasksScreen
            guard={stepUp.guard}
            client={client}
            tasks={tasks.tasks}
            width={inner}
            height={height}
            error={tasks.error}
            active={!stepUpOpen}
            onReload={tasks.reload}
            onClose={onBack}
          />
        )}
        {screen === 'inbox' && (
          <InboxScreen
            approvals={approvals}
            focused={barHasKeys}
            onFocusChange={onBarFocus}
            width={inner}
          />
        )}
        {screen === 'trace' && <TraceView state={brain} width={inner} />}
        {screen === 'nodes' && (
          <NodesScreen nodes={nodes.nodes} error={nodes.error} width={inner} />
        )}
        {screen === 'budget' && <BudgetView budget={budget} width={inner} />}
        {screen === 'presence' && (
          <PresenceScreen client={client} width={inner} active={!stepUpOpen} onClose={onBack} />
        )}
        {screen === 'help' && <HelpScreen width={inner} role={role} />}
        {screen === 'me' && (
          <StyleScreen
            client={client}
            width={inner}
            active={!stepUpOpen}
            onClose={onBack}
            onMemory={onMemory}
          />
        )}
        {screen === 'memory' && (
          <MemoryScreen client={client} width={inner} active={!stepUpOpen} onClose={onBack} />
        )}
        {screen === 'room' && room !== undefined && room.me !== undefined && (
          <RoomScreen
            client={client}
            roomId={room.roomId}
            me={room.me}
            ask={room.ask}
            width={inner}
            height={height}
            active={!stepUpOpen}
            onClose={onBack}
          />
        )}
      </Box>
    </ScreenFrame>
  )
}

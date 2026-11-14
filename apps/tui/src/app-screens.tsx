import type { KeithClient } from '@keith/client'
import type { Whoami } from '@keith/contracts'
import { GUTTER, ScreenFrame, type StatusInfo } from '@keith/ui'
import { Box } from 'ink'
import { ManageScreen } from './features/manage/index.ts'
import type { Nodes } from './features/nodes/index.ts'
import { type StepUp, StepUpDialog } from './features/stepup/index.ts'

export type Screen =
  | 'home'
  | 'chat'
  | 'help'
  | 'tasks'
  | 'trace'
  | 'nodes'
  | 'budget'
  | 'presence'
  | 'manage'
  | 'room'
  /** `/history`: the person's previous chat generations (`features/chat/history-screen.tsx`). */
  | 'history'
  /** The Me screen: the person's own reply style (`features/persona/style-screen.tsx`). */
  | 'me'
  /** Me > Memory: the person's own dreaming mode, last run and diary (`features/memory/memory-screen.tsx`). */
  | 'memory'
  | 'login'
  | 'logout'
  /** A plugin terminal view (`features/plugin-view`). */
  | 'view'

export interface AppScreensProps {
  screen: Screen
  client: KeithClient
  me: Whoami | undefined
  stepUp: StepUp
  nodes: Nodes
  /** Cells and rows of the whole terminal (Manage is a `ScreenFrame`). */
  width: number
  rows: number
  /** The connection and countdown of the title row. */
  status: StatusInfo
  loggedOut: boolean
  manageAt: number
  onLeaveManage(): void
}

/** Manage over the whole terminal; while the step-up prompt is open, a frame holding the prompt in its place. */
export function AppScreens({
  screen,
  client,
  me,
  stepUp,
  nodes,
  width,
  rows,
  status,
  loggedOut,
  manageAt,
  onLeaveManage,
}: AppScreensProps) {
  const stepUpOpen = stepUp.prompt !== undefined
  if (screen !== 'manage') return null
  return (
    <>
      {stepUpOpen && (
        <ScreenFrame width={width} height={rows} label="Manage" status={status}>
          <Box marginLeft={-GUTTER}>
            <StepUpDialog stepUp={stepUp} width={width - GUTTER * 2 + GUTTER} />
          </Box>
        </ScreenFrame>
      )}
      {me !== undefined && (
        <Box
          display={stepUpOpen ? 'none' : 'flex'}
          flexDirection="column"
          width={width}
          height={rows}
        >
          <ManageScreen
            client={client}
            me={me}
            guard={stepUp.guard}
            nodes={nodes}
            width={width}
            height={rows}
            status={status}
            active={!stepUpOpen && !loggedOut}
            initialSection={manageAt}
            onClose={onLeaveManage}
          />
        </Box>
      )}
    </>
  )
}

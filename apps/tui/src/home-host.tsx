import type { BudgetStatus, Health, ModelRoles, SuccessionHeirView, Task } from '@keith/contracts'
import type { BrainTrace, ConnectionKind } from '@keith/ui'
import { Box } from 'ink'
import type { ReactNode } from 'react'
import { ApprovalDialog, type Approvals } from './features/approvals/index.ts'
import type { BrainState } from './features/brain/index.ts'
import type { ChatNotice } from './features/chat/index.ts'
import {
  type HomeMotion,
  HomeScreen,
  type MenuTarget,
  type TurnState,
  type ViewEntry,
} from './features/home/index.ts'
import type { Identity } from './features/identity/index.ts'
import { capsOf, heirCaptionOf, SECTIONS, visibleSections } from './features/manage/index.ts'
import type { Nodes } from './features/nodes/index.ts'
import type { InviteNotice, RoomBanner } from './features/room/index.ts'
import { type StepUp, StepUpDialog } from './features/stepup/index.ts'

export interface HomeHostProps {
  width: number
  rows: number
  cellAspect: number
  /** A memory dream runs: the caption says `dreaming…` (features/home). */
  dreaming?: boolean
  trace: BrainTrace
  connection: ConnectionKind
  identity: Identity
  loggedOut: boolean
  /** The local socket is locked (423): the unlock panel is the way in. */
  locked?: boolean
  standalone: boolean
  /** The core as shown to the user (`~/.keith/core.sock`, a URL). */
  target: string
  health: Health | undefined
  roles: ModelRoles | undefined
  budget: BudgetStatus | undefined
  nodes: Nodes['nodes']
  tasks: readonly Task[]
  brain: BrainState
  turn: TurnState
  typing: boolean
  notice: ChatNotice | undefined
  /** The failed refresh of the approvals inbox, when nothing waits. */
  failed: string | undefined
  stepUp: StepUp
  approvals: Approvals
  /** The approval dialog owns the keys. */
  barHasKeys: boolean
  onBarFocus(focused: boolean): void
  /** The intro and idle-hide settings (default: `DEFAULT_HOME_MOTION`). */
  motion?: HomeMotion
  onChat(): void
  onAsk(text: string): void
  onAskCommand(line: string): void
  onLogin(): void
  /** The login panel to draw while signed out (App builds it: it owns the connection). */
  panel?: ((width: number) => ReactNode) | undefined
  onStop(): void
  onOpen(target: MenuTarget): void
  /** The plugin views the core lists for this person (default none). */
  views?: readonly ViewEntry[]
  /** The heir's succession view while a claim is coming or open (`useHeirSuccession`). */
  heir?: SuccessionHeirView | undefined
  /** The room banner row (`useRoomApp`). */
  banner?: RoomBanner | undefined
  /** An invitation to a room: its notice, and the accept and decline calls (hidden while the core is down). */
  invite?: { notice: InviteNotice; onAccept(): void; onDecline(): void } | undefined
}

/** Wires the app's state into the Home screen: header facts, the menu's sections, the dialogs. */
export function HomeHost(p: HomeHostProps) {
  const stepUpOpen = p.stepUp.prompt !== undefined
  const me = p.identity.status === 'ready' ? p.identity.me : undefined
  // a refused key's `offline:` hint takes the caption slot for its moment (it would hide under the alert)
  const hint = p.notice?.rows[0]?.startsWith('offline:') === true
  const linkDown = p.connection === 'disconnected' || p.connection === 'reconnecting'
  const auth = hint
    ? undefined
    : p.loggedOut
      ? ({ kind: 'logged-out', core: p.target } as const)
      : p.identity.status === 'error' || linkDown
        ? ({
            kind: 'core-down',
            core: p.target,
            detail: p.identity.status === 'error' ? p.identity.message : 'link down',
          } as const)
        : undefined
  const coreDown =
    p.loggedOut ||
    p.locked === true ||
    p.identity.status === 'error' ||
    p.connection === 'offline' ||
    linkDown
  const askEnabled =
    me !== undefined &&
    !coreDown &&
    !p.standalone &&
    !stepUpOpen &&
    p.approvals.answerable.length === 0
  const dialogs = (dialogWidth: number): ReactNode => (
    <>
      {stepUpOpen && (
        <Box marginTop={1}>
          <StepUpDialog stepUp={p.stepUp} width={dialogWidth} />
        </Box>
      )}
      {p.approvals.items.length > 0 && !stepUpOpen && (
        <Box marginTop={1}>
          <ApprovalDialog
            approvals={p.approvals}
            focused={p.barHasKeys}
            onFocusChange={p.onBarFocus}
            width={dialogWidth}
          />
        </Box>
      )}
    </>
  )
  return (
    <HomeScreen
      columns={p.width}
      rows={p.rows}
      cellAspect={p.cellAspect}
      active={!stepUpOpen && !p.barHasKeys}
      attention={stepUpOpen || p.barHasKeys || p.approvals.items.length > 0}
      {...(p.motion === undefined ? {} : { motion: p.motion })}
      trace={p.trace}
      dreaming={p.dreaming ?? false}
      connection={p.connection}
      turn={p.turn}
      typing={p.typing}
      alert={coreDown}
      auth={auth}
      heir={heirCaptionOf(p.heir)}
      chatEnabled={me !== undefined && !p.loggedOut && !p.standalone}
      askEnabled={askEnabled}
      sections={me === undefined ? [] : visibleSections(SECTIONS, capsOf(me))}
      {...(p.views === undefined ? {} : { views: p.views })}
      logout={me !== undefined && !p.loggedOut && !p.standalone}
      summary={{
        me,
        connection: p.connection,
        health: p.health,
        roles: p.roles,
        budget: p.budget,
        nodes: p.nodes,
        tasks: p.tasks,
        brain: p.brain,
      }}
      {...(p.banner === undefined ? {} : { banner: p.banner })}
      {...(p.invite === undefined || coreDown
        ? {}
        : { invite: { onAccept: p.invite.onAccept, onDecline: p.invite.onDecline } })}
      notices={[
        // an invitation is what the person must answer: it comes first, with its keys
        ...(p.invite === undefined || coreDown
          ? []
          : [
              {
                level: 'info' as const,
                rows: [`${p.invite.notice.text}  [enter] accept  [d] decline`],
              },
            ]),
        // the failed approvals refresh is noise while the core is down: the panel already says so
        ...(p.failed === undefined || coreDown
          ? []
          : [{ level: 'warning' as const, rows: [p.failed] }]),
        ...(p.notice === undefined ? [] : [p.notice]),
      ]}
      panel={p.panel}
      dialogs={dialogs}
      onChat={p.onChat}
      onAsk={p.onAsk}
      onAskCommand={p.onAskCommand}
      onLogin={p.onLogin}
      onStop={p.onStop}
      onOpen={p.onOpen}
    />
  )
}

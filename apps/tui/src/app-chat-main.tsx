import type { ContextKind } from '@keith/app-model'
import type { KeithClient } from '@keith/client'
import { frontSessionOf } from '@keith/client'
import type { ModelRoles, Task } from '@keith/contracts'
import { Box } from 'ink'
import { type ReactNode, type RefObject, useState } from 'react'
import { offlineBar, useLink } from './features/activity/index.ts'
import { type ChatNotice, ChatView, EmptyConversation } from './features/chat/index.ts'
import { useFrontGeneration } from './features/chat/use-front-generation.ts'
import type { TurnState } from './features/home/index.ts'
import type { Identity } from './features/identity/index.ts'
import type { DreamActivity } from './features/memory/index.ts'
import type { Layout } from './layout.ts'

export interface ChatMainProps {
  client: KeithClient
  identity: Identity
  layout: Layout
  /** The terminal width. */
  width: number
  /** `keith manage`: no chat. */
  standalone: boolean
  /** The chat is the screen on view. */
  onChat: boolean
  /** Something else owns the keys: an approval bar, a step-up prompt. */
  keysTaken: boolean
  loggedOut: boolean
  /** The sidebar sits beside the conversation inside the chat view. */
  inChat: boolean
  /** The chat view draws the header over the conversation (and the orb flies, so the view hides). */
  head: ReactNode
  veiled: boolean
  /** The logged-out panel (the chat's input is replaced by it). */
  loggedOutPanel: ReactNode
  /** The block shown when there is no session: `logged-out` or `core-down` panel. */
  noSession: ReactNode
  above: ReactNode
  legend: ReactNode
  side: ReactNode
  stopRef: RefObject<(() => void) | undefined>
  sendRef: RefObject<((text: string) => void) | undefined>
  notice: ChatNotice | undefined
  tasks: readonly Task[]
  roles: ModelRoles | undefined
  tabCompletes: boolean
  /** The `/new` or `/compact` in progress (context-pending.ts), and the compactions that ended (a refetch trigger). */
  contextPending: ContextKind | undefined
  compacted: number
  /** The memory dream of the person: the running line and the dividers (features/memory). */
  dream: DreamActivity
  onCommand(line: string): void
  onSend(): void
  onBusyChange(busy: boolean): void
  onTurn(turn: TurnState): void
  onDraftChange(draft: string): void
}

/** The chat column: the conversation and input when a session is open, else the empty conversation with the sign in or core-down block. */
export function ChatMain(p: ChatMainProps) {
  const { identity, layout } = p
  const offline = useLink()
  const generation = useFrontGeneration(
    p.client,
    identity.status === 'ready' ? identity.me.personId : undefined,
  )
  // the draft lives here, not in the chat view: a new generation mounts a new view and the typed text stays
  const [draft, setDraft] = useState('')
  return (
    <Box
      flexDirection="column"
      width={p.inChat ? p.width : layout.left}
      flexShrink={0}
      flexGrow={1}
    >
      {identity.status === 'ready' ? (
        p.standalone ? null : (
          <ChatView
            // a new generation is a new session: the view is mounted again on it
            key={frontSessionOf(identity.me.personId, generation)}
            client={p.client}
            sessionId={frontSessionOf(identity.me.personId, generation)}
            generation={generation}
            onCommand={p.onCommand}
            focus={p.onChat && !p.keysTaken && !p.loggedOut}
            hidden={!p.onChat}
            veiled={p.veiled}
            disabled={
              p.loggedOut
                ? p.loggedOutPanel
                : offline === undefined
                  ? undefined
                  : offlineBar(offline.reason)
            }
            above={p.above}
            legend={p.legend}
            stopRef={p.stopRef}
            sendRef={p.sendRef}
            notice={p.notice}
            onSend={p.onSend}
            onBusyChange={p.onBusyChange}
            onTurn={p.onTurn}
            onDraftChange={p.onDraftChange}
            draft={draft}
            onDraft={setDraft}
            width={layout.left}
            fullWidth={p.width}
            {...(p.inChat ? { side: p.side } : {})}
            {...(p.head === null ? {} : { head: p.head })}
            conversation={layout.conversation}
            prose={layout.prose}
            tasks={p.tasks}
            noModel={p.roles !== undefined && !p.roles.front}
            tabCompletes={p.tabCompletes}
            contextPending={p.contextPending}
            compacted={p.compacted}
            dream={p.dream}
          />
        )
      ) : p.onChat || p.standalone ? (
        <>
          <Box flexGrow={1} flexDirection="column">
            {!p.standalone && <EmptyConversation />}
          </Box>
          {p.legend}
          {(identity.status === 'logged-out' || identity.status === 'error') && (
            <Box marginTop={1}>{p.noSession}</Box>
          )}
        </>
      ) : null}
    </Box>
  )
}

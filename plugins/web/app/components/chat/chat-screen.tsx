import {
  type Auth,
  authorName,
  type ChatState,
  type ConnectionStatus,
  connectionLabel,
  type Fetch,
  type StoredSession,
  threadLabel,
  turnLabel,
} from '@keith/client'
import type { ThreadDto, ThreadId } from '@keith/protocol'
import { cn } from 'cn'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '../../hooks/use-chat.ts'
import { useMic, usePlayback } from '../../hooks/use-voice.ts'
import type { VoiceEnv } from '../../lib/voice.ts'
import { type BlockEnv, BlockEnvContext } from '../blocks/block-context.tsx'
import { type Credentials, LoginForm } from '../login-form.tsx'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert.tsx'
import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card.tsx'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '../ui/sheet.tsx'
import { Composer } from './composer.tsx'
import { type Byline, EntryView, isHiddenEntry } from './entries.tsx'
import { ThreadList } from './thread-list.tsx'
import { VoiceControls } from './voice-controls.tsx'

const ACTION_ERRORS = {
  invalid: 'This button cannot be used.',
  offline: 'Not connected: the click was not sent.',
} as const

/**
 * The open thread (history, streaming replies, tool lines, UI blocks, input, voice, connection
 * state) and, phase 5, the thread list: a sidebar on wide screens, a sheet on narrow ones.
 */
export function ChatScreen({
  baseUrl,
  auth,
  session,
  fetch,
  voice,
  onSignedOut,
}: {
  baseUrl: string
  auth: Auth
  session: StoredSession
  fetch?: Fetch | undefined
  voice: VoiceEnv
  onSignedOut: () => void
}) {
  const playback = usePlayback(voice)
  const { state, client } = useChat({
    baseUrl,
    session,
    auth,
    fetch,
    audio: playback.support,
    onAudio: playback.onAudio,
  })
  const mic = useMic({ client, env: voice, playback })
  const [token, setToken] = useState(session.token)
  const authRequired = state.connection.kind === 'auth-required'

  useEffect(() => {
    if (authRequired)
      auth.expire().catch((error: unknown) => console.warn('cannot expire the session', error))
  }, [authRequired, auth])

  const env = useMemo<BlockEnv>(
    () => ({
      sendAction: (action) => {
        if (!client) return ACTION_ERRORS.offline
        const result = client.sendUiAction(action)
        return result.ok ? null : ACTION_ERRORS[result.reason]
      },
      files: { baseUrl, token, fetch },
    }),
    [client, baseUrl, token, fetch],
  )

  const signInAgain = async (credentials: Credentials) => {
    const next = await auth.login(credentials)
    setToken(next.token)
    client?.reconnect(next.token)
  }

  const signOut = async () => {
    client?.close()
    await auth.logout()
    onSignedOut()
  }

  const online = state.connection.kind === 'online' && state.thread !== null
  const me = state.person ?? session.person
  const [sheetOpen, setSheetOpen] = useState(false)

  const selectThread = (threadId: ThreadId) => {
    setSheetOpen(false)
    const result = client?.openThread(threadId)
    if (result && !result.ok) console.warn('cannot open the thread', result.reason)
  }

  const threadList = (
    <ThreadList
      threads={state.threads}
      currentId={state.thread?.id ?? null}
      me={me}
      disabled={state.connection.kind !== 'online'}
      onSelect={selectThread}
    />
  )

  return (
    <BlockEnvContext.Provider value={env}>
      <div className="flex h-dvh">
        <aside data-slot="sidebar" className="hidden w-64 shrink-0 flex-col overflow-y-auto border-r md:flex">
          <p className="px-4 pt-4 pb-1 text-xs font-medium text-muted-foreground">Threads</p>
          {threadList}
        </aside>
        <div className="mx-auto flex h-dvh min-w-0 max-w-3xl flex-1 flex-col">
          <header className="flex items-center gap-3 border-b px-4 py-3">
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger
                render={<Button type="button" variant="outline" size="sm" className="md:hidden" />}
              >
                Threads
              </SheetTrigger>
              <SheetContent side="left" data-slot="thread-sheet">
                <SheetHeader>
                  <SheetTitle>Threads</SheetTitle>
                </SheetHeader>
                {threadList}
              </SheetContent>
            </Sheet>
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-semibold">Keith</h1>
              <p className="truncate text-xs text-muted-foreground" data-slot="thread-label">
                {me.name}
                {state.thread ? ` · ${threadLabel(state.thread, me)}` : ''}
              </p>
            </div>
            <ConnectionBadge status={state.connection} />
            <Button type="button" variant="ghost" size="sm" onClick={signOut}>
              Sign out
            </Button>
          </header>

          {state.thread?.kind === 'group' ? <GroupHeader thread={state.thread} /> : null}

          <ConnectionBanner status={state.connection} onRetry={() => client?.reconnect()} />

          {authRequired ? (
            <div className="p-4">
              <Card>
                <CardHeader>
                  <CardTitle>Sign in again</CardTitle>
                </CardHeader>
                <CardContent>
                  <LoginForm onSubmit={signInAgain} submitLabel="Sign in and reconnect" initialUsername="" />
                </CardContent>
              </Card>
            </div>
          ) : null}

          <Timeline state={state} onLoadOlder={() => void client?.loadOlder()} />

          <footer className="flex flex-col gap-2 border-t px-4 py-3">
            <TurnIndicator state={state} />
            <VoiceControls
              mic={mic}
              unavailable={voice.unavailable}
              online={online}
              listening={state.turnState === 'listening'}
              playing={playback.playing}
            />
            <Composer
              online={online}
              busy={state.turnState !== 'idle'}
              onSend={(text) => client?.send(text) ?? { ok: false, reason: 'offline' }}
              onCancel={() => client?.cancel()}
            />
          </footer>
        </div>
      </div>
    </BlockEnvContext.Provider>
  )
}

/** Phase 5: a group's title, purpose and participants, above its timeline. */
function GroupHeader({ thread }: { thread: ThreadDto }) {
  return (
    <div data-slot="group-header" className="flex flex-col gap-0.5 border-b px-4 py-2">
      <p className="text-sm font-medium">{thread.title}</p>
      {thread.purpose ? <p className="text-xs text-muted-foreground">{thread.purpose}</p> : null}
      <p data-slot="group-participants" className="text-xs text-muted-foreground">
        {thread.participants.map((p) => p.name).join(', ')}
      </p>
    </div>
  )
}

/** Phase 5: in a group, who wrote each person's message, and whether it was the signed-in person. */
function bylineOf(state: ChatState, entry: ChatState['entries'][number]): Byline | undefined {
  if (state.thread?.kind !== 'group' || entry.kind !== 'message' || entry.role !== 'user') return undefined
  const id = entry.authorPersonId
  return {
    author: authorName(state, entry),
    mine: id === undefined || id === state.person?.id,
  }
}

function Timeline({ state, onLoadOlder }: { state: ChatState; onLoadOlder: () => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  const entries = state.entries.filter((e) => !isHiddenEntry(e))
  const last = entries[entries.length - 1]
  const lastSize = last?.kind === 'message' ? last.text.length + last.ui.length : 0

  // Follow new entries and streamed text.
  useEffect(() => {
    const el = scroller.current
    if (el && (last !== undefined || lastSize >= 0)) el.scrollTop = el.scrollHeight
  }, [last, lastSize])

  return (
    <div ref={scroller} className="flex-1 overflow-y-auto px-4 py-4" data-slot="timeline">
      <div className="flex flex-col gap-3">
        {state.history.hasMore ? (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={state.history.loading}
              onClick={onLoadOlder}
            >
              {state.history.loading ? 'Loading…' : 'Load older messages'}
            </Button>
          </div>
        ) : null}
        {entries.length === 0 && state.thread ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No messages yet.</p>
        ) : null}
        {entries.map((entry) => (
          <EntryView key={entry.key} entry={entry} byline={bylineOf(state, entry)} />
        ))}
      </div>
    </div>
  )
}

function TurnIndicator({ state }: { state: ChatState }) {
  const label = turnLabel(state.turnState)
  return (
    <div
      data-slot="turn-state"
      data-state={state.turnState}
      className="h-4 text-xs text-muted-foreground"
      aria-live="polite"
    >
      {label ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 animate-pulse rounded-full bg-primary" />
          Keith is {label}
        </span>
      ) : null}
    </div>
  )
}

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const online = status.kind === 'online'
  return (
    <Badge data-slot="connection" data-status={status.kind} variant={online ? 'secondary' : 'outline'}>
      <span className={cn('size-1.5 rounded-full', online ? 'bg-emerald-500' : 'bg-amber-500')} />
      {online ? 'online' : status.kind === 'connecting' ? 'connecting' : 'offline'}
    </Badge>
  )
}

function ConnectionBanner({ status, onRetry }: { status: ConnectionStatus; onRetry: () => void }) {
  if (status.kind !== 'reconnecting' && status.kind !== 'closed') return null
  return (
    <div className="px-4 pt-3" data-slot="connection-banner">
      <Alert variant={status.kind === 'closed' ? 'destructive' : 'default'}>
        <AlertTitle>{status.kind === 'closed' ? 'Disconnected' : 'Connection lost'}</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>{connectionLabel(status)}</span>
          {status.kind === 'reconnecting' ? (
            <Button type="button" variant="outline" size="xs" onClick={onRetry}>
              Retry now
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    </div>
  )
}

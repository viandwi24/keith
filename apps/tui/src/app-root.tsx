import type { KeithClient } from '@keith/client'
import { createGuestClient } from '@keith/client'
import { MotionProvider, type Scheduler, ToastProvider, ToastStack, useToast } from '@keith/ui'
import { useWindowSize } from 'ink'
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, type AppProps } from './app.tsx'
import { type Connection, clientFor, coreLabel, type SwitchOptions } from './connection.ts'
import { GuestScreen } from './features/guest/index.ts'
import { PresenceProvider } from './features/presence/index.ts'
import { ProposalNotice } from './features/protocols/index.ts'
import { loadConfig, type MotionConfig } from './platform/config.ts'
import { revokeOnQuit } from './quit-revoke.ts'

export interface AppRootProps
  extends Omit<AppProps, 'client' | 'core' | 'connection' | 'switchConnection' | 'enterGuest'> {
  /** Where the app talks to at first; the app may replace it (`switchConnection`). */
  connection: Connection
  /** Build the client of a connection (default `clientFor`; tests inject their own). */
  makeClient?(connection: Connection): KeithClient
  /** Intro, idle hide and reduced motion (default: from the environment through `loadConfig`). */
  motion?: MotionConfig
  /** Time source of the fades (default real time; tests step it by hand). */
  scheduler?: Scheduler
  /** The app component (default `App`; a test wraps it to reach `switchConnection`). */
  component?: ComponentType<AppProps>
  /** The presence heartbeat's cadence (default 20 s; tests use a short one). */
  presenceHeartbeatMs?: number
}

interface Current {
  connection: Connection
  /** The one client of `connection`, built when the connection was set. */
  client: KeithClient
  /** Bumped on every swap: it is the `key` of the app, so everything below is rebuilt. */
  generation: number
  start: AppProps['start']
  flash: string | undefined
}

/** Shows `SwitchOptions.notice` once, as a success toast, when the app of a new connection mounts. */
function FlashToast({ text }: { text: string }) {
  const { push } = useToast()
  useEffect(() => {
    push(text, { level: 'success' })
  }, [push, text])
  return null
}

/** Guest chat in place of the app (reached from the sign-in panel); leaving gives the app back. */
function GuestPage({
  url,
  fetch: fetchImpl,
  columns,
  rows,
  onLeave,
}: {
  url: string
  fetch?: typeof fetch | undefined
  columns?: number | undefined
  rows?: number | undefined
  onLeave(): void
}) {
  const size = useWindowSize()
  const client = useMemo(
    () =>
      createGuestClient({ baseUrl: url, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) }),
    [url, fetchImpl],
  )
  return (
    <GuestScreen
      client={client}
      target={url}
      columns={columns ?? size.columns}
      rows={rows ?? size.rows}
      onLeave={onLeave}
    />
  )
}

/**
 * The app owns its connection (P13). This root holds the current `Connection`, builds the one client
 * of it and renders `App` keyed by a generation. A swap changes the connection and bumps the
 * generation: React unmounts the old `App`, so every hook stops its activity feed (`useActivity`),
 * the chat session, the polls and the dialogs of the old client, and a new tree starts on the new
 * client with no state of the old one. `KeithClient` has no timers of its own to dispose: its feed
 * and sessions are owned by the hooks.
 */
export function AppRoot({
  connection,
  makeClient = clientFor,
  component: Component = App,
  motion: motionProp,
  scheduler,
  start,
  presenceHeartbeatMs,
  ...rest
}: AppRootProps) {
  const motion = useMemo(() => motionProp ?? loadConfig().motion, [motionProp])
  const build = useRef(makeClient)
  build.current = makeClient
  const [current, setCurrent] = useState<Current>(() => ({
    connection,
    client: makeClient(connection),
    generation: 0,
    start,
    flash: undefined,
  }))
  // a sign-in that is not remembered ends with the process: revoke it when the app unmounts (a clean quit)
  const live = useRef({ current, configPath: rest.configPath })
  live.current = { current, configPath: rest.configPath }
  useEffect(
    () => () => {
      const { current: now, configPath } = live.current
      void revokeOnQuit(now.connection, now.client, configPath)
    },
    [],
  )
  const switchConnection = useCallback((next: Connection, options: SwitchOptions = {}) => {
    const client = build.current(next)
    setCurrent((prev) => ({
      connection: next,
      client,
      generation: prev.generation + 1,
      start: options.start ?? 'home',
      flash: options.notice,
    }))
  }, [])
  const [guest, setGuest] = useState<string | undefined>()
  const enterGuest = useCallback((url: string) => setGuest(url), [])
  if (guest !== undefined)
    return (
      <GuestPage
        url={guest}
        fetch={rest.guestFetch}
        columns={rest.columns}
        rows={rest.rows}
        onLeave={() => setGuest(undefined)}
      />
    )
  return (
    <MotionProvider
      reduced={motion.reduced}
      orbStatic={motion.orbStatic}
      {...(scheduler === undefined ? {} : { scheduler })}
    >
      <ToastProvider>
        {/* this terminal is one of the person's clients (presence): registered for as long as this app is mounted */}
        <PresenceProvider
          key={current.generation}
          client={current.client}
          configPath={rest.configPath}
          heartbeatMs={presenceHeartbeatMs}
        >
          <Component
            key={current.generation}
            motion={motion}
            {...rest}
            client={current.client}
            core={coreLabel(current.connection)}
            connection={current.connection}
            switchConnection={switchConnection}
            enterGuest={enterGuest}
            {...(current.start === undefined ? {} : { start: current.start })}
          />
        </PresenceProvider>
        {/* a new protocol proposal of this person is one toast line (P28.4.4); the read stops when signed out */}
        <ProposalNotice key={`proposals-${current.generation}`} client={current.client} />
        {current.flash === undefined ? null : (
          <FlashToast key={`flash-${current.generation}`} text={current.flash} />
        )}
        <ToastStack {...(rest.columns === undefined ? {} : { columns: rest.columns })} />
      </ToastProvider>
    </MotionProvider>
  )
}

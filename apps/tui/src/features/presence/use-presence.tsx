import { hostname } from 'node:os'
import {
  createPresenceReporter,
  detectEnvironment,
  fileClientIdStore,
  type KeithClient,
  type PresenceReporter,
  TERMINAL_CAPABILITIES,
  UnsupportedDelivery,
} from '@keith/client'
import type {
  ClientCapability,
  DisclosureAudience,
  DisclosureLevel,
  PresenceMine,
  PresenceStatusSet,
  PresenceStatusView,
} from '@keith/contracts'
import { useToast } from '@keith/ui'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import pkg from '../../../package.json' with { type: 'json' }

/**
 * The capabilities this terminal app serves: a chat, a notice (a toast), a view it opens and Markdown on screen
 * (`TERMINAL_CAPABILITIES`, client). Opt-in location is not announced.
 */
export const TUI_CAPABILITIES: readonly ClientCapability[] = TERMINAL_CAPABILITIES

const NO_TOUCH = (): void => {}
const TouchContext = createContext<() => void>(NO_TOUCH)

/** The `touch()` of the app's presence reporter: a key or a sent message tells the core the person is here. */
export const usePresenceTouch = (): (() => void) => useContext(TouchContext)

/** Opens the screen a delivery names (`name`); `false` when this terminal cannot (the delivery is acked `unsupported`). */
export type ViewOpener = (name: string) => boolean
type OpenerSlot = { current: ViewOpener | undefined }
const NO_OPENER: OpenerSlot = { current: undefined }
const OpenerContext = createContext<OpenerSlot>(NO_OPENER)

/**
 * The app says how it opens a view on an `open.view` delivery. The presence provider sits above the app, so the app
 * hands its opener up through this hook (kept for as long as the app is mounted, read at each delivery).
 */
export function usePresenceViewOpener(open: ViewOpener): void {
  const slot = useContext(OpenerContext)
  useEffect(() => {
    slot.current = open
    return () => {
      slot.current = undefined
    }
  })
}

export interface PresenceProviderProps {
  client: KeithClient
  /** `client.json` path: the client id is kept beside it (`client-state.json`). Undefined keeps the id in memory only. */
  configPath: string | undefined
  /** Heartbeat cadence (the reporter's default, 20 s, when absent). */
  heartbeatMs?: number | undefined
  children: ReactNode
}

/**
 * Registers this terminal as one of the person's clients for as long as it is mounted (docs/specs/tui.md, "Presence").
 * A notice from the core (a `brain.parietal.deliver` for this client) shows as a toast. Keyed by the app's generation in
 * `AppRoot`, so a new connection registers a new reporter.
 */
export function PresenceProvider({
  client,
  configPath,
  heartbeatMs,
  children,
}: PresenceProviderProps) {
  const { push } = useToast()
  const reporter = useRef<PresenceReporter | undefined>(undefined)
  const opener = useRef<ViewOpener | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    let made: PresenceReporter | undefined
    let offNotify: (() => void) | undefined
    let offView: (() => void) | undefined
    // the client id is kept per person (docs/specs/client.md): whoami names the person this reporter registers for
    client.rpc.auth
      .whoami()
      .then((me) => {
        if (cancelled) return
        const reporterFor = createPresenceReporter(client, {
          kind: 'tui',
          label: hostname().slice(0, 40) || 'terminal',
          capabilities: [...TUI_CAPABILITIES],
          version: pkg.version,
          // where this terminal runs (host, OS, device, time zone): read once, sent on register (docs/decisions/0033 §2)
          environment: () => detectEnvironment(),
          store:
            configPath === undefined ? memoryStore() : fileClientIdStore(configPath, me.personId),
          ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
        })
        made = reporterFor
        reporter.current = reporterFor
        reporterFor.start()
        offNotify = reporterFor.onNotify((delivery) => {
          push(noticeText(delivery.name, delivery.text), { level: 'info' })
        })
        // a view the app cannot open (unknown, or no app mounted) is acked `unsupported`
        offView = reporterFor.onDeliver('open.view', (delivery) => {
          if (opener.current?.(delivery.name) !== true) throw new UnsupportedDelivery()
          return 'opened'
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      offNotify?.()
      offView?.()
      reporter.current = undefined
      void made?.stop()
    }
  }, [client, configPath, heartbeatMs, push])
  const touch = useCallback(() => reporter.current?.touch(), [])
  return (
    <TouchContext.Provider value={touch}>
      <OpenerContext.Provider value={opener}>{children}</OpenerContext.Provider>
    </TouchContext.Provider>
  )
}

/** The toast of a notice: `Keith · <name>`, and `: <text>` when the core sent a text (P27.5.1). */
export function noticeText(name: string, text: string | undefined): string {
  return text === undefined || text.trim() === '' ? `Keith · ${name}` : `Keith · ${name}: ${text}`
}

/** A client id kept in memory for this run (no config path: nothing is written to disk). */
function memoryStore(): { read(): string | undefined; write(id: string): void } {
  let id: string | undefined
  return {
    read: () => id,
    write: (next) => {
      id = next
    },
  }
}

export interface PresenceData {
  /** What the core answered, or `undefined` while the first read is out. */
  mine: PresenceMine | undefined
  /** The read failed (the core is down or the login is refused). */
  error: string | undefined
  reload(): void
  /** Set the level one audience may read; the answer is read again. */
  setLevel(audience: DisclosureAudience, level: DisclosureLevel): Promise<void>
  /** Busy (with a note and a lifetime) or free; the state is read again. */
  setStatus(input: PresenceStatusSet): Promise<PresenceStatusView>
}

/** The person's own presence, clients and settings, read from the core (`presence.mine`) and changed through it. */
export function usePresenceData(client: KeithClient): PresenceData {
  const [mine, setMine] = useState<PresenceMine | undefined>()
  const [error, setError] = useState<string | undefined>()
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const reload = useCallback(() => {
    client.rpc.presence.mine().then(
      (value) => {
        if (!alive.current) return
        setMine(value)
        setError(undefined)
      },
      (e: Error) => {
        if (alive.current) setError(e.message)
      },
    )
  }, [client])
  useEffect(() => {
    reload()
  }, [reload])
  const setLevel = useCallback(
    async (audience: DisclosureAudience, level: DisclosureLevel) => {
      await client.rpc.presence.disclosure.set({ audience, level })
      reload()
    },
    [client, reload],
  )
  const setStatus = useCallback(
    async (input: PresenceStatusSet) => {
      const view = await client.rpc.presence.setStatus(input)
      reload()
      return view
    },
    [client, reload],
  )
  return { mine, error, reload, setLevel, setStatus }
}

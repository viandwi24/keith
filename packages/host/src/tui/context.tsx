import { useWindowSize } from 'ink'
import { createContext, type ReactNode, useContext } from 'react'
import type { ViewEventsOptions } from './view-keith.ts'

/**
 * What a view may do with the platform (docs/specs/plugin-views.md, "Data and operations"). The provider holds
 * the viewer's actor behind `call`; it exposes no database, config, session object or credential.
 */
export interface Keith {
  /** `<plugin>.<view>`. */
  readonly viewId: string
  /** Run `<plugin>.<operation>` as the viewer: the guard applies (capability, ACL, rate limit, audit). */
  call<T = unknown>(target: string, input?: unknown): Promise<T>
  /**
   * Typed events of a plugin (`<plugin>.<event>`) for the viewer; returns an unsubscribe function. `options.onResync`
   * is called when records may have been lost (a prune passed the listener's cursor): refetch what the events feed.
   */
  events(target: string, handler: (data: unknown) => void, options?: ViewEventsOptions): () => void
}

export interface TerminalInfo {
  cols: number
  rows: number
  /** The client's colour depth (the server always renders truecolor; the client quantizes). */
  colorDepth: 1 | 4 | 8 | 24
}

interface Value {
  keith: Keith
  colorDepth: TerminalInfo['colorDepth']
}

const Context = createContext<Value | undefined>(undefined)

export function KeithProvider({
  keith,
  colorDepth,
  children,
}: {
  keith: Keith
  colorDepth: TerminalInfo['colorDepth']
  children: ReactNode
}) {
  return <Context.Provider value={{ keith, colorDepth }}>{children}</Context.Provider>
}

/** The platform handle of a view. Throws outside a view host. */
export function useKeith(): Keith {
  const value = useContext(Context)
  if (value === undefined) throw new Error('useKeith() is only available inside a Keith view')
  return value.keith
}

/** The terminal size (it follows a resize) and the client's colour depth. */
export function useTerminal(): TerminalInfo {
  const value = useContext(Context)
  const { columns, rows } = useWindowSize()
  if (value === undefined) throw new Error('useTerminal() is only available inside a Keith view')
  return { cols: columns, rows, colorDepth: value.colorDepth }
}

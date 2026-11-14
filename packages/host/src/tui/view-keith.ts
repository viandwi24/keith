import { GuardError } from '../errors.ts'
import type { Guard } from '../guard.ts'
import type { KeithPlugin } from '../types.ts'
import type { Keith } from './context.tsx'

/** Who is looking at a view. Never a credential: the host authenticated them already. */
export interface Viewer {
  /** The person id (`principal.personId`). */
  readonly principalId: string
  /** The login method behind the connection (`password`, `token`, ...), for the audit row of the calls. */
  readonly method: string | null
}

/** Options of one event subscription (all optional). */
export interface ViewEventsOptions {
  /**
   * Called when records may have been lost: the feed was pruned past the listener's cursor, so events of this
   * subscription between two polls can be gone (they are never replayed). A view that keeps state from events refetches
   * here. Not called for an ordinary gap in the sequence and never for a listener that is not yet attached.
   */
  onResync?: () => void
}

/** Typed events for a viewer; the core implements it over the activity feed. Optional. */
export interface ViewEventsPort {
  subscribe(
    viewer: Viewer,
    plugin: string,
    event: string,
    handler: (data: unknown) => void,
    options?: ViewEventsOptions,
  ): () => void
}

/**
 * The `Keith` handle of one view: `call` runs an operation through `guard.run` with the **viewer** as principal,
 * so every check of the guard applies to what the view reads and writes. The view is never elevated (it has no way
 * to step up). `signal` aborts the calls in flight when the view closes.
 */
export function createViewKeith(deps: {
  guard: Guard
  plugins: () => readonly KeithPlugin[]
  events?: ViewEventsPort
}): (viewer: Viewer, viewId: string, signal: AbortSignal) => Keith {
  return (viewer, viewId, signal) => ({
    viewId,
    async call(target, input = {}) {
      const dot = target.indexOf('.')
      const op =
        dot < 1
          ? undefined
          : deps
              .plugins()
              .find((p) => p.id === target.slice(0, dot))
              ?.operation(target.slice(dot + 1))
      // `expose.call` is the same switch `k.call` honours: an operation closed to calls is closed to views
      if (op === undefined || !op.expose.call) throw new GuardError('NOT_FOUND', 'call')
      return (await deps.guard.run(op, input, {
        principal: { id: viewer.principalId },
        session: { id: null, kind: 'api', method: viewer.method, elevated: false },
        signal,
      })) as never
    },
    events(target, handler, options) {
      const dot = target.indexOf('.')
      if (dot < 1 || deps.events === undefined) return () => {}
      return deps.events.subscribe(
        viewer,
        target.slice(0, dot),
        target.slice(dot + 1),
        handler,
        options,
      )
    },
  })
}

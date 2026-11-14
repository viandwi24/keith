import type { PersonRole } from '@keith/contracts'
import type { Principal } from '../auth/index.ts'

/** What an open stream was allowed with when it started. */
export interface OpenStreamFacts {
  personId: string
  /** The credential behind the request; absent on the local socket's implicit owner. */
  credentialId: string | undefined
  /** `legacy` for a pre-credentials token (its id lives in the tokens table). */
  credentialKind: string | undefined
  role: PersonRole
  /** The person's capabilities at open (sorted, joined): a change ends the stream. */
  grantsKey: string
}

export interface OpenStreamsOptions {
  /**
   * Whether the stream's principal is still valid right now (credential live and in time, person
   * active, same role, same capabilities). A throw or `false` closes the stream (fail closed).
   */
  stillAllowed?: (facts: OpenStreamFacts) => boolean | Promise<boolean>
  /** Backstop sweep period (default 30 s). */
  sweepMs?: number
  warn?: (message: string) => void
}

export interface OpenStreams {
  /**
   * Track a long-lived request. The returned request carries a `signal` that is a child of the
   * stream's controller (eharness listens only to `request.signal`): closing aborts it. `release`
   * forgets the stream when the response is over.
   */
  open(
    principal: Principal,
    request: Request,
    grantsKey: string,
  ): { request: Request; release: () => void }
  /** Close every open stream of a person; returns how many. */
  closePerson(personId: string): number
  /** Close the streams opened with a credential; returns how many. */
  closeCredential(credentialId: string): number
  /** Streams open now (tests, doctor). */
  size(): number
  /** Re-check every open stream now (the sweep calls this). */
  sweep(): Promise<number>
  /** Stop the sweep and close every stream (the core stops). */
  close(): void
}

interface Entry extends OpenStreamFacts {
  controller: AbortController
}

/**
 * The long-lived requests of the thalamus (`/activity/*`, `/sessions/*` streams, `/attention`) with
 * who opened them. A revoked credential, a suspended person, a role or capability change closes the
 * person's streams at once (the triggers call `closePerson` / `closeCredential`); a sweep re-checks
 * what changed without a trigger (a credential that ran out). A closed stream reconnects, is
 * resolved again and gets 401 (docs/specs/thalamus.md, "Activity feed").
 */
export function createOpenStreams(options: OpenStreamsOptions = {}): OpenStreams {
  const entries = new Set<Entry>()
  const closeWhere = (match: (entry: Entry) => boolean): number => {
    let closed = 0
    for (const entry of [...entries]) {
      if (!match(entry)) continue
      entries.delete(entry)
      entry.controller.abort(new Error('access changed'))
      closed++
    }
    return closed
  }
  let sweeping: Promise<number> | undefined
  const sweep = (): Promise<number> => {
    if (sweeping !== undefined) return sweeping
    sweeping = (async () => {
      let closed = 0
      for (const entry of [...entries]) {
        let allowed = false
        try {
          allowed = (await options.stillAllowed?.(entry)) ?? true
        } catch (error) {
          options.warn?.(`open streams: re-check failed, closing: ${String(error)}`)
        }
        if (!allowed) closed += closeWhere((e) => e === entry)
      }
      return closed
    })().finally(() => {
      sweeping = undefined
    })
    return sweeping
  }
  const timer = setInterval(() => void sweep(), options.sweepMs ?? 30_000)
  timer.unref?.()

  return {
    open(principal, request, grantsKey) {
      const controller = new AbortController()
      const entry: Entry = {
        personId: principal.personId,
        credentialId: principal.credential?.id,
        credentialKind: principal.credential?.kind,
        role: principal.role,
        grantsKey,
        controller,
      }
      entries.add(entry)
      const signal = AbortSignal.any([request.signal, controller.signal])
      const release = () => void entries.delete(entry)
      signal.addEventListener('abort', release, { once: true })
      return { request: new Request(request, { signal }), release }
    },
    closePerson: (personId) => closeWhere((e) => e.personId === personId),
    closeCredential: (credentialId) => closeWhere((e) => e.credentialId === credentialId),
    size: () => entries.size,
    sweep,
    close() {
      clearInterval(timer)
      closeWhere(() => true)
    },
  }
}

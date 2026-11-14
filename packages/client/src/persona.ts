// The persona and the reply style on the client (docs/specs/prefrontal.md "RPC", docs/specs/client.md). `personaApiOf` wraps the
// `rpc.persona.*` procedures in one typed object, like `roomsApiOf`: each method is the procedure of the same name, typed by
// `@keith/contracts`. Owner changes need the step-up of the call; the server refuses them without it (the client does not check).
import {
  PERSONA_CHANGED,
  PersonaChangedRecordSchema,
  type PersonaEditInput,
  type PersonaRestoreInput,
  type PersonaSetTemplateInput,
  type PersonaStyleReadInput,
  type PersonaStyleSetInput,
  type PersonaVersion,
  type PersonaView,
  type PersonStyle,
} from '@keith/contracts'
import type { KeithClient } from './client.ts'

/** The persona API of one client: each method is one `rpc.persona.*` procedure. */
export interface PersonaApi {
  get(): Promise<PersonaView>
  history(): Promise<PersonaVersion[]>
  setTemplate(input: PersonaSetTemplateInput): Promise<PersonaView>
  edit(input: PersonaEditInput): Promise<PersonaView>
  restore(input: PersonaRestoreInput): Promise<PersonaView>
  style: {
    get(): Promise<PersonStyle>
    set(input: PersonaStyleSetInput): Promise<PersonStyle>
    read(input: PersonaStyleReadInput): Promise<PersonStyle>
  }
}

/** The persona API over a client's typed `rpc` (`client.persona` is this for the client it was created with). */
export function personaApiOf(client: Pick<KeithClient, 'rpc'>): PersonaApi {
  const { persona } = client.rpc
  return {
    get: () => persona.get(),
    history: () => persona.history(),
    setTemplate: (input) => persona.setTemplate(input),
    edit: (input) => persona.edit(input),
    restore: (input) => persona.restore(input),
    style: {
      get: () => persona.style.get(),
      set: (input) => persona.style.set(input),
      read: (input) => persona.style.read(input),
    },
  }
}

/** The part of the activity feed the persona watch uses (`client.feed()` satisfies it). */
export interface PersonaFeed {
  subscribeEvents(fn: (record: { type: string; payload: unknown }) => void): () => void
  subscribeResync(fn: (reason: string) => void): () => void
}

/**
 * Calls `refetch` on each `persona.changed` record (a version was written; the record holds no text) and on every feed resync,
 * since a change made while the feed was down is only read again by a refetch. Other records, and a `persona.changed` whose
 * payload does not match its schema, do nothing. Returns the detach function.
 */
export function watchPersona(options: { feed: PersonaFeed; refetch: () => void }): () => void {
  const offEvents = options.feed.subscribeEvents((record) => {
    if (record.type !== PERSONA_CHANGED) return
    if (!PersonaChangedRecordSchema.safeParse(record.payload).success) return
    options.refetch()
  })
  const offResync = options.feed.subscribeResync(() => options.refetch())
  return () => {
    offEvents()
    offResync()
  }
}

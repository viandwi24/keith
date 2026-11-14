// The prefrontal region's wiring (docs/specs/prefrontal.md "Region", "Audit", "Removal", "Feed"; ADR-0029): the persona service
// over the versioned repo, the per-person style service, and the removal part of a removed person (ADR-0027 §26). The activity
// records (`brain.prefrontal.change`, `persona.changed`, `brain.prefrontal.style`) go to the feed through `emit`. The first boot
// seed is run by compose.ts, once the region exists.
import { personaRepo, personStyleRepo, type Sqlite } from '@keith/db'
import type { ActivityStore } from 'eharness/activity'
import type { createIdentity } from './compose-identity.ts'
import { emit } from './modules/brain-events/index.ts'
import {
  createPersonaService,
  createPersonStyleService,
  type PersonaActivity,
  type PersonaService,
  type PersonStyleService,
  prefrontalProcedures,
  prefrontalRemoval,
} from './modules/prefrontal/index.ts'
import type { FrontGenerationOf } from './platform/sessions.ts'

type Identity = ReturnType<typeof createIdentity>

export interface PrefrontalWiring {
  /** The current front generation of each person (ADR-0030 §2): the session of every front call. */
  generations: FrontGenerationOf
  sqlite: Sqlite
  dataDir: string
  identity: Pick<Identity, 'audit' | 'aclAudit' | 'people' | 'removal'>
  /** The activity feed: the region's records are appended here, with no text. */
  store: ActivityStore
  warn: (message: string) => void
}

/** The region as the core holds it: the services and the RPC procedures the router mounts (`compose-regions.ts`). */
export interface PrefrontalRegion {
  persona: PersonaService
  styles: PersonStyleService
  procedures: ReturnType<typeof prefrontalProcedures>
}

export function createPrefrontal(w: PrefrontalWiring): PrefrontalRegion {
  const { sqlite, identity, store, warn } = w
  const persona = personaRepo(sqlite)
  const styles = personStyleRepo(sqlite)
  const activity: PersonaActivity = {
    record: (sessionId, type, payload) => emit(store, type, sessionId, null, payload, warn),
  }
  const service = createPersonaService({
    persona,
    people: identity.people,
    audit: identity.audit,
    activity,
  })
  const styleService = createPersonStyleService({
    styles,
    generations: w.generations,
    people: identity.people,
    audit: identity.audit,
    aclAudit: identity.aclAudit,
    activity,
  })
  // a removed person's style is kept, exported or purged with the rest of their data; the persona is never removed with them
  identity.removal.registry.registerRemoval({
    module: 'prefrontal',
    onPersonRemoved: prefrontalRemoval({ styles, sqlite, dataDir: w.dataDir }),
  })
  return {
    persona: service,
    styles: styleService,
    procedures: prefrontalProcedures({ persona: service, styles: styleService }),
  }
}

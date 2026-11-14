import type { FrontGenerationOf } from './platform/sessions.ts'
// The parietal region's wiring (docs/specs/parietal.md): the service over the presence tables, and the removal part of
// a removed person's presence (ADR-0027 §26). The timer and the procedures are wired by compose.ts and compose-regions.ts.

import type { AclStore } from '@keith/acl'
import {
  clientsRepo,
  presenceDisclosureRepo,
  presenceSignalsRepo,
  presenceStatusRepo,
  type Sqlite,
} from '@keith/db'
import type { ActivityStore } from 'eharness/activity'
import type { CoreTiming } from './compose-timers.ts'
import type { AclAudit } from './modules/audit/index.ts'
import {
  createParietalService,
  type ParietalService,
  parietalRemoval,
} from './modules/parietal/index.ts'
import type { PeopleService, RemovalService } from './modules/people/index.ts'

export interface ParietalWiring {
  /** The current front generation of each person (ADR-0030 §2): the session of every front call. */
  generations: FrontGenerationOf
  sqlite: Sqlite
  /** The activity feed: `brain.parietal.presence` is written on the person's front session. */
  store: ActivityStore
  people: Pick<PeopleService, 'list' | 'get'>
  /** The groups of the audiences (`group:<id>`) and the owner-access audit of a member's detail. */
  acl: AclStore
  audit: Pick<AclAudit, 'ownerAccess'>
  removal: RemovalService
  dataDir: string
  timing: Pick<CoreTiming, 'clientTimeoutMs' | 'activeWindowMs' | 'awayAfterMs'>
  warn: (message: string) => void
}

/** The parietal service over the presence tables; its removal part is registered in the removal registry. */
export function createParietal(w: ParietalWiring): ParietalService {
  const service = createParietalService({
    generations: w.generations,
    repos: {
      clients: clientsRepo(w.sqlite),
      signals: presenceSignalsRepo(w.sqlite),
      status: presenceStatusRepo(w.sqlite),
      disclosure: presenceDisclosureRepo(w.sqlite),
    },
    people: w.people,
    acl: w.acl,
    audit: w.audit,
    store: w.store,
    windows: {
      clientTimeoutMs: w.timing.clientTimeoutMs,
      activeWindowMs: w.timing.activeWindowMs,
      awayAfterMs: w.timing.awayAfterMs,
    },
    warn: w.warn,
  })
  w.removal.registry.registerRemoval({
    module: 'parietal',
    onPersonRemoved: parietalRemoval({ sqlite: w.sqlite, dataDir: w.dataDir }),
  })
  return service
}

// The push share of a removed person's data (ADR-0027 §26, docs/specs/push.md "Removal"): subscriptions are device secrets,
// never exported or kept; they are deleted with the person.
import type { PersonRemovalHooks } from '../people/index.ts'
import type { PushService } from './service.ts'

export function pushRemoval(service: Pick<PushService, 'purge'>): PersonRemovalHooks {
  return {
    keep() {
      return undefined
    },
    export() {},
    purge(personId) {
      service.purge(personId)
    },
  }
}

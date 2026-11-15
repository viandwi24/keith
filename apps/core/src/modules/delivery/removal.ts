// The delivery share of a removed person's data (ADR-0027 §26, docs/specs/delivery.md "Removal"). Held rows follow the
// pending ones (listed on `export`, deleted on `purge`). Pending rows stay in
// place on `keep`: the service retries them and each ends as `recipient-gone` (the creator is told). `export` lists their
// ids only, and `purge` deletes what is still pending after the keep time.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DeliveriesRepo } from '@keith/db'
import type { PersonRemovalHooks } from '../people/index.ts'

export function deliveryRemoval(deliveries: DeliveriesRepo): PersonRemovalHooks {
  return {
    keep() {
      return undefined
    },
    export(personId, dest) {
      const pending = [...deliveries.pendingFor(personId), ...deliveries.heldFor(personId)].map(
        (row) => row.id,
      )
      if (pending.length === 0) return
      mkdirSync(dest, { recursive: true })
      writeFileSync(
        join(dest, 'deliveries.json'),
        `${JSON.stringify({ personId, pending }, null, 2)}\n`,
        { mode: 0o600 },
      )
    },
    purge(personId) {
      deliveries.deletePendingFor(personId)
      deliveries.deleteHeldFor(personId)
    },
  }
}

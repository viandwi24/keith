import type { GuestBlock } from '@keith/contracts'
import type { ProviderService } from '../providers/index.ts'
import type { GuestBudget } from './guest-budget.ts'
import type { GuestSettingsStore } from './settings.ts'

/** Whether a new guest session would be accepted right now, and if not the first reason (docs/specs/guests.md). */
export interface EntryGate {
  /** `open` is how many sessions are open right now (the registry's size). */
  block(open: number): Promise<GuestBlock | null>
  /**
   * The synchronous part of the check, run again after `block`'s awaits: a kill switch or a disable that
   * landed meanwhile refuses the start (F-023). Only `killed` and `disabled` can come back.
   */
  recheck(): GuestBlock | null
  /**
   * The same reasons as `block`, read-only: no ledger write (the status route calls it on every poll). The limits
   * are the settings' own until a start seeds them.
   */
  peek(open: number): Promise<GuestBlock | null>
}

export interface EntryGateOptions {
  store: GuestSettingsStore
  providers: Pick<ProviderService, 'rolePricing'>
  budget: Pick<GuestBudget, 'seed' | 'block' | 'peekBlock'>
}

/**
 * The entry order of the owner-side checks: kill switch, enabled, a `guest` model that is priced, every guest scope
 * has a limit (seeded here), the owner's floor, the daily and monthly caps, then concurrency. Zone, Host and
 * per-IP checks belong to the HTTP layer and come before these.
 */
export function createEntryGate(options: EntryGateOptions): EntryGate {
  const { store, providers, budget } = options
  return {
    recheck() {
      if (store.killed()) return 'killed'
      return store.get().enabled ? null : 'disabled'
    },
    async block(open) {
      if (store.killed()) return 'killed'
      const settings = store.get()
      if (!settings.enabled) return 'disabled'
      const model = await providers.rolePricing('guest')
      if (model.ref === null) return 'no-model'
      if (!model.priced) return 'unpriced-model'
      budget.seed()
      const money = budget.block()
      if (money !== null) return money
      return open >= settings.maxConcurrent ? 'full' : null
    },
    async peek(open) {
      if (store.killed()) return 'killed'
      const settings = store.get()
      if (!settings.enabled) return 'disabled'
      const model = await providers.rolePricing('guest')
      if (model.ref === null) return 'no-model'
      if (!model.priced) return 'unpriced-model'
      const money = budget.peekBlock()
      if (money !== null) return money
      return open >= settings.maxConcurrent ? 'full' : null
    },
  }
}

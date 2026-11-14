import type {
  GuestEnded,
  GuestEndReason,
  GuestPeek,
  GuestSessionInfo,
  GuestSettings,
  GuestSettingsPatch,
  GuestStatus,
} from '@keith/contracts'
import type { ProviderService } from '../providers/index.ts'
import type { EntryGate } from './gate.ts'
import type { GuestBudget } from './guest-budget.ts'
import { GuestError, type GuestSettingsStore } from './settings.ts'

/** The live sessions as the owner surface needs them (`GuestRegistry` implements it; step 4). */
export interface GuestSessionsPort {
  list(): GuestSessionInfo[]
  /** Ends one session; false when there is no such session. */
  end(id: string, reason: GuestEndReason): Promise<boolean>
  /** Ends every session; returns how many. */
  endAll(reason: GuestEndReason): Promise<number>
  /** The live transcript of one session, or undefined when there is none. */
  peek(id: string): Promise<GuestPeek | undefined>
}

/** A port with no sessions (nothing has opened one). */
export const noGuestSessions: GuestSessionsPort = {
  list: () => [],
  end: async () => false,
  endAll: async () => 0,
  peek: async () => undefined,
}

export interface GuestAdminOptions {
  store: GuestSettingsStore
  providers: Pick<ProviderService, 'rolePricing'>
  sessions: GuestSessionsPort
  /** Why entry would be refused now (`createEntryGate`). */
  gate: EntryGate
  /** What the guests' money looks like. */
  budget: Pick<GuestBudget, 'view'>
  /** The configured public URL (for the `public` zone rule). */
  publicUrl: () => string | null | undefined
}

/** One settings change as the audit records it: only the keys that moved. */
export interface GuestSettingsChange {
  before: Partial<GuestSettings>
  after: Partial<GuestSettings>
  /** Sessions ended because guests were turned off. */
  ended: number
  /** `enable` also lifted the kill switch. */
  killLifted: boolean
}

export interface GuestAdmin {
  status(): Promise<GuestStatus>
  /** Merge settings. Enabling needs a priced `guest` model; disabling ends every session; enabling lifts the kill switch. */
  set(patch: GuestSettingsPatch): Promise<{ status: GuestStatus; change: GuestSettingsChange }>
  /** `on`: end every session and refuse entry until enabled again; `off` only lifts the switch. */
  killswitch(on: boolean): Promise<GuestEnded>
  list(): GuestSessionInfo[]
  end(id: string): Promise<GuestEnded>
  /** The live transcript of a session; `NOT_FOUND` when it is gone. */
  peek(id: string): Promise<GuestPeek>
}

/** The owner's view and levers over guest mode (`admin.guests.*`, `keith-core guests`). */
export function createGuestAdmin(options: GuestAdminOptions): GuestAdmin {
  const { store, providers, sessions, budget, gate } = options
  const status = async (): Promise<GuestStatus> => {
    const settings = store.get()
    const model = await providers.rolePricing('guest')
    return {
      settings,
      killed: store.killed(),
      model,
      active: sessions.list().length,
      blocked: await gate.block(sessions.list().length),
      budget: budget.view(),
    }
  }
  return {
    status,
    async set(patch) {
      const before = store.get()
      if (patch.enabled === true) {
        const model = await providers.rolePricing('guest')
        if (model.ref === null)
          throw new GuestError(
            'BAD_REQUEST',
            'pick a model for the guest role first (keith-core model set guest <connection:model>)',
          )
        if (!model.priced)
          throw new GuestError(
            'BAD_REQUEST',
            `the guest model ${model.ref} has no known price, so the budget could not count it: pick a priced model`,
          )
      }
      const after = store.set(patch, { publicUrl: options.publicUrl() })
      const killLifted = patch.enabled === true && store.killed()
      if (killLifted) store.setKilled(false)
      const ended = patch.enabled === false ? await sessions.endAll('killed') : 0
      const keys = Object.keys(patch) as Array<keyof GuestSettings>
      const moved = keys.filter(
        (k) => patch[k] !== undefined && JSON.stringify(before[k]) !== JSON.stringify(after[k]),
      )
      return {
        status: await status(),
        change: {
          before: Object.fromEntries(moved.map((k) => [k, before[k]])),
          after: Object.fromEntries(moved.map((k) => [k, after[k]])),
          ended,
          killLifted,
        },
      }
    },
    async killswitch(on) {
      store.setKilled(on)
      return { ended: on ? await sessions.endAll('killed') : 0 }
    },
    list: () => sessions.list(),
    async peek(id) {
      const peek = await sessions.peek(id)
      if (peek === undefined) throw new GuestError('NOT_FOUND', `no guest session ${id}`)
      return peek
    },
    async end(id) {
      const ended = await sessions.end(id, 'killed')
      if (!ended) throw new GuestError('NOT_FOUND', `no guest session ${id}`)
      return { ended: 1 }
    },
  }
}

import type {
  ClientAck,
  ClientHeartbeat,
  ClientRecord,
  ClientRef,
  ClientRegister,
  DisclosureRow,
  DisclosureSet,
  PresenceMine,
  PresenceStatusSet,
  PresenceStatusView,
} from '@keith/contracts'

/** Presence of the fake core: what `presence.mine` answers at first, and the state the procedures change. */
export interface FakePresenceOptions {
  /** The state the owner sees: presence, clients, manual status and disclosure (partial: the rest defaults). */
  mine?: Partial<PresenceMine>
}

/** The presence procedures of the fake core and every call they saw (the TUI's reporter and panel). */
export interface FakePresence {
  /** Handlers by procedure name (`presence/clients/register`, ...), merged into the fake core's `/rpc/*`. */
  handlers: Record<string, (input: unknown) => unknown>
  /** The state `presence.mine` answers now. */
  state: PresenceMine
  registers: ClientRegister[]
  heartbeats: ClientHeartbeat[]
  goodbyes: ClientRef[]
  acks: ClientAck[]
  statusSets: PresenceStatusSet[]
  disclosureSets: DisclosureSet[]
}

const NOW = Date.UTC(2026, 10, 10, 9, 0)

const defaults = (): PresenceMine => ({
  presence: {
    personId: 'owner',
    state: 'active',
    reachableOn: [],
    activeClient: null,
    note: null,
    asOf: NOW,
  },
  clients: [],
  status: { busy: false, note: null, until: null },
  disclosure: [
    { audience: 'owner', level: 'detail' },
    { audience: '@users', level: 'state' },
  ],
})

/** A fake presence service: registers and records the calls, and keeps the disclosure and status it was set to. */
export function createFakePresence(options: FakePresenceOptions = {}): FakePresence {
  const base = defaults()
  const state: PresenceMine = {
    ...base,
    ...options.mine,
    presence: { ...base.presence, ...options.mine?.presence },
    status: { ...base.status, ...options.mine?.status },
    clients: options.mine?.clients ?? base.clients,
    disclosure: options.mine?.disclosure ?? base.disclosure,
  }
  const registers: ClientRegister[] = []
  const heartbeats: ClientHeartbeat[] = []
  const goodbyes: ClientRef[] = []
  const acks: ClientAck[] = []
  const statusSets: PresenceStatusSet[] = []
  const disclosureSets: DisclosureSet[] = []
  const handlers: FakePresence['handlers'] = {
    'presence/clients/register': (input) => {
      const register = input as ClientRegister
      registers.push(register)
      const record: ClientRecord = {
        ...register,
        personId: state.presence.personId,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        lastActiveAt: null,
        online: true,
      }
      return record
    },
    'presence/clients/heartbeat': (input) => {
      heartbeats.push(input as ClientHeartbeat)
      return { ok: true }
    },
    'presence/clients/goodbye': (input) => {
      goodbyes.push(input as ClientRef)
      return { ok: true }
    },
    'presence/clients/ack': (input) => {
      acks.push(input as ClientAck)
      return { ok: true }
    },
    'presence/clients/list': () => state.clients,
    'presence/mine': () => state,
    'presence/setStatus': (input) => {
      const set = input as PresenceStatusSet
      statusSets.push(set)
      const view: PresenceStatusView = set.busy
        ? {
            busy: true,
            note: set.note ?? null,
            until: set.minutes === undefined ? null : Date.now() + set.minutes * 60_000,
          }
        : { busy: false, note: null, until: null }
      state.status = view
      return view
    },
    'presence/disclosure/set': (input) => {
      const set = input as DisclosureSet
      disclosureSets.push(set)
      const row: DisclosureRow = { audience: set.audience, level: set.level }
      state.disclosure = [...state.disclosure.filter((r) => r.audience !== set.audience), row]
      return row
    },
  }
  return { handlers, state, registers, heartbeats, goodbyes, acks, statusSets, disclosureSets }
}

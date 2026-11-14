import type { SuccessionState } from '@keith/contracts'
import { MS_HOUR, SUCCESSION_GRACE_DAYS } from '@keith/contracts'

export interface FakeSuccessionCall {
  /** `admin/succession/setWindow` */
  name: string
  input: unknown
}

export interface FakeSuccession {
  /** Every `admin/succession/*` call the TUI made, in order, with its input. */
  calls: FakeSuccessionCall[]
  /** Pass as `rpc` of `setupApp` (merged over the admin procedures). */
  rpc: Record<string, (input: unknown) => unknown>
  /** The state of the one run; `claim` moves it to `claimed`. */
  state: SuccessionState
  /** The owner's heir, or `null`. */
  heir: { id: string; name: string } | null
  windowDays: number
  pausedUntil: number | null
  inputs(name: string): unknown[]
}

/** The clock of the fixtures, read once at load: the TUI renders relative ages (`3 days ago`) from the real clock. */
export const SUCCESSION_NOW = Date.now()

export interface FakeSuccessionOptions {
  /** `owner`: the owner view; `heir`: the heir view; `none`: neither (`NOT_FOUND`). */
  role?: 'owner' | 'heir' | 'none'
  state?: SuccessionState
  heir?: { id: string; name: string } | null
  windowDays?: number
  pausedUntil?: number | null
  /** `claim` refuses with `owner-returned` (a sign after the run began) when set. */
  ownerReturned?: boolean
}

const err = (message: string, code: string, status: number): Error =>
  Object.assign(new Error(message), { code, status })

/**
 * The `admin.succession.*` procedures over one in-memory run. The owner view (`owner`), the heir view (`heir`) or
 * `NOT_FOUND` (`none`). `claim` works only in `claimable` and then answers the transfer; a refusal changes nothing.
 */
export function createFakeSuccession(options: FakeSuccessionOptions = {}): FakeSuccession {
  const calls: FakeSuccessionCall[] = []
  const role = options.role ?? 'owner'
  const fake = {
    state: options.state ?? 'idle',
    heir: options.heir === undefined ? { id: 'bo-id', name: 'Bo' } : options.heir,
    windowDays: options.windowDays ?? 14,
    pausedUntil: options.pausedUntil ?? null,
  }
  const person = (id: string, name: string) => ({
    id,
    username: name.toLowerCase(),
    name,
    role: id === 'owner' ? ('member' as const) : ('owner' as const),
    status: 'active' as const,
    canLogin: true,
    createdBy: null,
    createdAt: SUCCESSION_NOW,
    updatedAt: SUCCESSION_NOW,
  })
  const owner = () => ({
    role: 'owner' as const,
    state: fake.state,
    heir: fake.heir,
    windowDays: fake.windowDays,
    pausedUntil: fake.pausedUntil,
    lastSignAt: SUCCESSION_NOW - 3 * 24 * MS_HOUR,
    runId: fake.state === 'idle' ? null : 'run-1',
    startedAt: fake.state === 'idle' ? null : SUCCESSION_NOW - 9 * 24 * MS_HOUR,
    graceStartedAt:
      fake.state === 'grace' || fake.state === 'claimable'
        ? SUCCESSION_NOW - 2 * 24 * MS_HOUR
        : null,
    claimableAt: fake.state === 'claimable' ? SUCCESSION_NOW - 1 * MS_HOUR : null,
  })
  // the grace began 2 days ago: it opens the claim 5 days from now (the grace length of the core)
  const graceEnd = SUCCESSION_NOW - 2 * 24 * MS_HOUR + SUCCESSION_GRACE_DAYS * 24 * MS_HOUR
  const heirView = () => ({
    role: 'heir' as const,
    state: fake.state,
    claimableAt: fake.state === 'claimable' ? SUCCESSION_NOW - 1 * MS_HOUR : null,
    claimOpensAt:
      fake.state === 'grace'
        ? graceEnd
        : fake.state === 'claimable'
          ? SUCCESSION_NOW - 1 * MS_HOUR
          : null,
  })
  const record =
    (name: string, fn: (input: unknown) => unknown) =>
    (input: unknown): unknown => {
      calls.push({ name, input })
      return fn(input)
    }
  const raw: Record<string, (input: unknown) => unknown> = {
    'admin/succession/get': () => {
      if (role === 'owner') return owner()
      if (role === 'heir') return heirView()
      throw err('not the owner or the heir', 'NOT_FOUND', 404)
    },
    'admin/succession/setHeir': (i) => {
      const { person: id } = i as { person: string }
      fake.heir = { id, name: id === 'bo-id' ? 'Bo' : 'Ana' }
      return owner()
    },
    'admin/succession/clearHeir': () => {
      fake.heir = null
      return owner()
    },
    'admin/succession/setWindow': (i) => {
      fake.windowDays = (i as { days: number }).days
      return owner()
    },
    'admin/succession/pause': (i) => {
      fake.pausedUntil = (i as { until: number }).until
      return owner()
    },
    'admin/succession/resume': () => {
      fake.pausedUntil = null
      return owner()
    },
    'admin/succession/claim': () => {
      if (options.ownerReturned === true)
        throw err('the owner came back: the claim is off', 'PRECONDITION_FAILED', 412)
      if (fake.state !== 'claimable') throw err('the claim is not open', 'PRECONDITION_FAILED', 412)
      fake.state = 'claimed'
      return { owner: person('heir-id', 'Bo'), previousOwner: person('owner', 'Owner') }
    },
  }
  const rpc = Object.fromEntries(Object.entries(raw).map(([name, fn]) => [name, record(name, fn)]))
  return {
    calls,
    rpc,
    get state() {
      return fake.state
    },
    set state(next: SuccessionState) {
      fake.state = next
    },
    get heir() {
      return fake.heir
    },
    get windowDays() {
      return fake.windowDays
    },
    get pausedUntil() {
      return fake.pausedUntil
    },
    inputs: (name) => calls.filter((c) => c.name === name).map((c) => c.input),
  }
}

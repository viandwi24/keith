import type { BudgetStatus, Whoami } from '@keith/contracts'
import type { UIMessage } from 'ai'
import type { FakeGuest, FakeGuestOptions } from './fake-guest.ts'
import type { FakePresence, FakePresenceOptions } from './fake-presence.ts'
import type { FakeViews, FakeViewsOptions } from './fake-views.ts'

export interface FakeCore {
  url: string
  /** Request lines seen (`METHOD /path`). */
  seen: string[]
  /** Append a record to the activity feed and push it to every open stream. */
  emit(record: FakeRecord): void
  /** Tell every open stream its cursor is gone (`event: resync`): the client refetches state. */
  resync(): void
  /** Items `GET /attention` lists now (answering one removes it). */
  attention: unknown[]
  /** Every `POST /attention/:id/answer` seen: the item id, its session and the whole body. */
  answers: Array<{ id: string; body: { sessionId?: string; answer?: unknown } }>
  /** Make the next answers fail with this HTTP status (409 = answered elsewhere); 0 = succeed. */
  failAnswers(status: number): void
  /** Activity streams currently open. */
  streams(): number
  /**
   * Cut the next chat answer after this many words (the response body errors, like a dropped
   * connection). The turn then "runs" on the core (snapshot `running`) until `GET /chat/stream`
   * has replayed the whole answer; the replay is stored as the assistant message.
   * `until`: the cut waits (at most 10 s) until it returns true, e.g. until the UI shows the words
   * sent so far. A client that sees the drop before it has made the assistant message does not
   * re-attach (an error with no reply yet is a failed send), so on a loaded machine a test that
   * asserts the recovery must hold the cut until the reply is on screen. With `afterWords` 0 the
   * cut lands before the first byte (the chat never sees an assistant message): a failed send that
   * `attachChat` + `reportChatNotice` must still recover from, ungated.
   */
  dropNextAnswer(afterWords: number, until?: () => boolean): void
  /** The core restarted: every open activity stream gets `event: boot` with this new id. */
  reboot(id: string): void
  /**
   * Close every activity stream and refuse new ones (also the polling fallback) with `status`
   * (default 503; 401 makes the feed `unauthorized`); `false` restores it.
   */
  feedDown(down: boolean, status?: number): void
  /** The credential was revoked: every call but `/health` is 401 from now on and open streams close. */
  revoke(): void
  /** What the snapshot says: a turn runs (a restarted core finds the stored turn unfinished). */
  setRunning(running: boolean): void
  /** Store a message of the session (e.g. an interrupted assistant reply). */
  pushHistory(message: UIMessage): void
  /** Every `POST /chat` seen: its trigger, the message id of a regenerate and the sent text. */
  chats: Array<{ trigger?: string; messageId?: string; text?: string }>
  /** Every `POST /auth/login` seen (the username and label; never the password). */
  logins: Array<{ username: string; label?: string }>
  /** The identifiers `POST /auth/identify` saw, in order. */
  identified: string[]
  /** Every flow answer seen: who it was for and which method (never the secret). */
  flowAnswers: Array<{ identifier: string; method: string; remember?: true }>
  /** How many times the first-owner flow set a PIN (the PIN itself is never kept). */
  firstOwnerSets: number[]
  /** Every `POST /auth/device/start` seen. */
  devices: Array<{ label?: string }>
  /** Calls of `auth.logout` (the credential is revoked from then on). */
  logouts: number
  /** The owner approves, denies or lets expire the pending device code. */
  decideDevice(decision: 'approved' | 'denied' | 'expired'): void
  /** Every `POST /auth/step-up` body seen. */
  stepUps: Array<{ pin?: string; password?: string }>
  /** What the plugin view routes saw (only with the `views` option). */
  views: FakeViews | undefined
  /** What the guest routes saw (only with the `guest` option). */
  guest: FakeGuest['state']
  /** The presence procedures: every register, heartbeat, goodbye, ack, status and disclosure set seen, and the state. */
  presence: FakePresence
  /** Add spending to the budget and emit a `budget-changed` activity record. */
  spend(usd: number): void
  stop(): void
}

/** An activity record as a test writes it; `seq` and `createdAt` are filled in. */
export interface FakeRecord {
  type: string
  payload: unknown
  sessionId?: string
}

/** Step-up behaviour of the fake core (`/auth/step-up`). */
export interface FakeStepUp {
  /** Attention answers and `tasks/stop` are refused with `KEITH_STEP_UP_REQUIRED` until a step-up succeeded. */
  required?: boolean
  /** The PIN that works (default `1234`). */
  pin?: string
  /** The password that works (default none). */
  password?: string
  /** Every step-up fails the same way: 429 `throttled`, 403 `no_method`, 409 `legacy`. */
  fail?: 'throttled' | 'no_method' | 'legacy'
}

/** A member of the fake core (`whoami` and the budget the member sees); pass as `whoami`. */
export const MEMBER: Partial<Whoami> = {
  personId: 'ana-id',
  name: 'Ana',
  username: 'ana',
  role: 'member',
}

/** Sign-in behaviour of the fake core (`/auth/methods`, `/auth/login`, the device routes). */
export interface FakeAuth {
  /** The one username and password `POST /auth/login` accepts (without it every login is a 401). */
  password?: { username: string; password: string }
  /** Every login is a 429 with this `Retry-After` (seconds). */
  throttle?: number
  /** The answer of `GET /auth/methods` (default: all three available). */
  methods?: Array<{ id: 'device' | 'password' | 'token'; available: boolean; reason?: string }>
}

/** Identifier-first sign-in of the fake core (`POST /auth/identify`, `POST /auth/flow/:id`). */
export interface FakeFlow {
  /** The zone the core says it sees the client in (default `loopback`). */
  context?: 'loopback' | 'lan' | 'tailscale' | 'public'
  /** The people that exist, by identifier, with the secrets that work; any other identifier gets a decoy. */
  people: Record<string, { pin?: string; password?: string }>
  /** `false`: the method is listed as refused with a reason (default: allowed). */
  pin?: boolean
  password?: boolean
  /** Every flow answer is a 429 with this `Retry-After` (seconds). */
  throttle?: number
  /**
   * Serve the socket's first-owner routes (`GET /auth/local/status`, `POST /auth/local/first-owner`):
   * `true` = the owner has no PIN yet (the flow is open until one is set), `false` = closed.
   */
  firstOwner?: boolean
}

export interface FakeCoreOptions {
  /** Serve `/plugins/tui/menu` and `/plugins/views/ws` like a core with plugin views. */
  views?: FakeViewsOptions
  /** Serve the guest listener's routes (`/guest/*`) like a core with guests on. */
  guest?: FakeGuestOptions
  /** The presence procedures' starting state (`presence.mine`); the procedures always answer. */
  presence?: FakePresenceOptions
  /** Listen on this Unix socket path instead of a TCP port (a core on the local socket). */
  unix?: string
  /** Sign-in routes; they answer even while the credential is revoked. */
  auth?: FakeAuth
  /** Identifier-first sign-in; without it `/auth/identify` is a 404 (an older core). */
  flow?: FakeFlow
  /** The credential is refused from the start (a signed-out client); a sign-in lifts it. */
  revoked?: boolean
  /** Overrides of the `auth/whoami` answer (default: the owner; `MEMBER` for a member). */
  whoami?: Partial<Whoami>
  /** Step-up behaviour; without it every answer works and `/auth/step-up` accepts PIN `1234`. */
  stepUp?: FakeStepUp
  /** Attention item ids whose answer is refused with `KEITH_WAITING_FOR_OWNER` (403). */
  waitingForOwner?: string[]
  /** Reply text of every chat turn, streamed in a few deltas. */
  reply?: string
  /** oRPC answers by procedure path (`providers/list`): the `json` of the response. */
  rpc?: Record<string, (input: unknown) => unknown>
  /** Items of `GET /attention` at start (wire shape of eharness `AttentionItem`). */
  attention?: unknown[]
  /** Stored messages the session starts with. */
  history?: UIMessage[]
  /** Starting budget of `budget/get` (default: limit 20, spent 0, a fixed month). */
  budget?: Partial<BudgetStatus>
}

import type { AuthZone, MethodDescriptor, Step } from '@keith/contracts'
import type { ClientConfig } from './config.ts'

/** A method id is whatever the core lists (`device`, `pin`, `password`, `token`, a future `totp`). */
export type SignInMethod = string

/** One entry of the method list, exactly as the core describes it (`MethodDescriptor`). */
export type SignInMethodItem = MethodDescriptor

/** Why a sign-in step failed. */
export type SignInFailure =
  | 'unreachable'
  | 'not_keith'
  | 'invalid'
  | 'throttled'
  | 'not_allowed_here'
  | 'unavailable'
  | 'expired'
  | 'denied'
  | 'rejected'
  | 'save_failed'
  /** The core cannot keep this device signed in (a remembered login needs the flow route). */
  | 'remember_unavailable'

export interface SignInPerson {
  name: string
  username: string | null
  role: string
}

/** What `GET /health` says about the core (the build it runs). */
export interface SignInCoreInfo {
  version: string
  sha: string
}

/** The last thing that went wrong in a step the user can simply repeat. Never holds a secret. */
export interface SignInProblem {
  reason: SignInFailure
  /** Fit to show; the same words for a known and an unknown identifier. */
  message: string
  /** Epoch ms when a throttled attempt may be repeated (the UI computes the countdown). */
  retryAt?: number
}

/**
 * Every state of the sign-in flow: `address -> checking -> identify -> flow(step...) -> done`.
 * No state ever holds a password, a PIN, a token or a credential: only the identifier, which is
 * not secret and which the form keeps filled after a failure.
 */
export type SignInState =
  /** Asking for the core address. `problem` says why the last one was refused. */
  | { step: 'address'; address: string; problem?: string }
  /** The local socket: the socket is the login. */
  | { step: 'socket'; address: string }
  /** Asking the core `/health`. */
  | { step: 'checking'; core: string }
  /** The core answered: asking who is signing in (a user id, username, email or phone). */
  | {
      step: 'identify'
      core: string
      info: SignInCoreInfo
      identifier: string
      problem?: SignInProblem
    }
  /** A request is in flight (identify, an answer, or saving and asking who you are). */
  | { step: 'working'; core: string; method: SignInMethod | undefined }
  /**
   * The core listed the methods for this client. `method` is the one on screen (the core's
   * `default` first), `current` the step to draw: its fields, by `kind`, with no code per method.
   * `context` is the zone the core sees this client in (`lan` = plain HTTP: the UI warns).
   */
  | {
      step: 'flow'
      core: string
      info: SignInCoreInfo
      identifier: string
      context: AuthZone
      methods: readonly SignInMethodItem[]
      method: SignInMethod
      current: Step
      problem?: SignInProblem
    }
  /** Waiting for the owner to approve `code`; `expiresAt` is epoch ms. */
  | {
      step: 'device'
      core: string
      code: string | undefined
      expiresAt: number | undefined
      polling: boolean
    }
  /** `note`: a warning the app shows with the sign-in (the previous login could not be revoked). */
  | { step: 'done'; core: string; person: SignInPerson | undefined; note?: string }
  /** The core could not be reached or is not Keith (before any identity is asked). */
  | { step: 'error'; core: string; reason: SignInFailure; message: string; retryable: boolean }

export interface SignInStore {
  /** Keeps the credential. A promise resolves with a warning note to show, or nothing. A throw is `save_failed`. */
  write(config: ClientConfig): string | undefined | Promise<string | undefined>
}

/** Where the typed identifier is remembered between runs (not a secret). */
export interface IdentifierMemory {
  read(core: string): string | undefined
  write(core: string, identifier: string): void
}

export interface SignInOptions {
  /** Initial address (`http(s)://…`, `host:port`, or `unix:<path>`). Default `DEFAULT_CORE`. */
  address?: string
  /** Set when a core answers on the local socket: with no `address`, the flow starts in `socket`. */
  socketPath?: string
  fetch?: typeof fetch
  now?: () => number
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Where the credential is saved (default: `writeClientConfig` at the default path, mode 0600). */
  store?: SignInStore
  /** Remembers the identifier that signed in and pre-fills it next time (default: nothing is remembered). */
  remember?: IdentifierMemory
  /** Name the owner sees for this device (default: the core's own default label). */
  label?: string
  /** Start with "remember this device" on (default off: the credential stays in memory). */
  rememberDevice?: boolean
  /** Device poll interval (default `DEVICE_POLL_MS`). */
  pollMs?: number
  /** How long a sign-in waits for `auth.whoami` before it says `done` without a name (default 3 s). */
  whoamiTimeoutMs?: number
  /** Aborts everything in flight, like `dispose()`. */
  signal?: AbortSignal
}

export interface SignIn {
  get(): SignInState
  subscribe(listener: (state: SignInState) => void): () => void
  /** Normalize and validate the address, then ask the core (`/health`) and move on to `identify`. */
  submitAddress(address: string): Promise<void>
  /** Ask the core which methods this identifier may use from here (`POST /auth/identify`). */
  submitIdentifier(identifier: string): Promise<void>
  /** Show another method of the list (no request). */
  chooseMethod(method: SignInMethod): void
  /**
   * Answer the step on screen: `answer` maps field names to what was typed (empty for a `poll`
   * method, which starts the device code). Secrets are used for this call only and never stored.
   */
  submitStep(answer: Readonly<Record<string, string>>): Promise<void>
  /**
   * "Remember this device": when on, the next password or PIN answer asks the core for a 30 days idle session and
   * the store receives `remember: true` with the credential. Default off: the store gets the credential with no
   * marker and a UI keeps it in memory. Takes no effect on a device code, a pasted token or an older core.
   */
  setRememberDevice(on: boolean): void
  rememberDevice(): boolean
  /** Can the method on screen be remembered (a password or PIN answer on a core with the flow routes)? */
  canRememberDevice(): boolean
  /** Abort a device wait or any request in flight; goes back to where it started. */
  cancel(): void
  /** One step back (flow to identify, identify to address). */
  back(): void
  /** Repeat the health check after an `error`. */
  retry(): Promise<void>
  /** Stop everything; later calls do nothing. */
  dispose(): void
}

export const FAILURE_MESSAGES: Record<SignInFailure, string> = {
  unreachable: 'cannot reach the core',
  not_keith: 'this address answers, but it does not look like a Keith core',
  // one line for every wrong answer: it never says whether the identifier exists
  invalid: 'sign-in failed: check your id and what you typed',
  throttled: 'too many attempts: wait before trying again',
  not_allowed_here:
    'the core does not accept this login from this network: use Tailscale, the device code, or ask the owner to set KEITH_INSECURE_LOGIN',
  unavailable: 'the core is busy: try again in a moment',
  expired: 'the code expired: ask for a new one',
  denied: 'the owner denied this login',
  rejected: 'the core refused the login request',
  save_failed: 'signed in, but the credential could not be saved',
  remember_unavailable: 'this core cannot keep this device signed in: sign in without remembering',
}

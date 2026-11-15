import { AuthMethodsSchema, type AuthZone, HealthSchema, type Step } from '@keith/contracts'
import { createKeithClient } from './client.ts'
import { DEFAULT_CORE } from './client-config.ts'
import { DeviceLoginError, deviceLoginResult } from './login.ts'
import { LoginError, passwordLogin } from './password.ts'
import { type AnswerOutcome, requestAnswer, requestIdentify } from './sign-in-requests.ts'
import {
  FAILURE_MESSAGES,
  type SignIn,
  type SignInCoreInfo,
  type SignInFailure,
  type SignInMethod,
  type SignInMethodItem,
  type SignInOptions,
  type SignInPerson,
  type SignInProblem,
  type SignInState,
  type SignInStore,
} from './sign-in-types.ts'
import { adoptSession, endWebSession, WebSessionError } from './web-session.ts'

export type {
  IdentifierMemory,
  SignIn,
  SignInCoreInfo,
  SignInFailure,
  SignInMethod,
  SignInMethodItem,
  SignInOptions,
  SignInPerson,
  SignInProblem,
  SignInState,
  SignInStore,
} from './sign-in-types.ts'

/** How long `GET /auth/methods` may take (an older core, fallback only). */
const METHODS_TIMEOUT_MS = 5000
/** After `retryAfter` is missing from a 429. */
const DEFAULT_RETRY_MS = 30_000
/** How long to wait for `auth.whoami` after a login before saying `done` without a name. */
const WHOAMI_TIMEOUT_MS = 3000

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done)
  })

export type ParsedAddress = { kind: 'unix'; path: string } | { kind: 'http'; url: string }

/** `unix:<path>`, or an http(s) URL (a bare `host:port` gets `http://`); trailing slashes are dropped. */
export function parseSignInAddress(value: string): ParsedAddress | { error: string } {
  const text = value.trim()
  if (text === '') return { error: 'type the address of your core' }
  if (text.startsWith('unix:')) {
    const path = text.slice('unix:'.length)
    return path === ''
      ? { error: 'unix: needs a path, e.g. unix:/path/core.sock' }
      : { kind: 'unix', path }
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { error: `"${text}" is not an http(s) address` }
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '')
    return { error: `"${text}" is not an http(s) address` }
  return { kind: 'http', url: withScheme.replace(/\/+$/, '') }
}

const PASSWORD_STEP: Step = {
  id: 'password',
  title: 'Password',
  fields: [{ name: 'password', label: 'Password', kind: 'secret', mask: true }],
}

/** The three fixed methods of a core that has no `/auth/identify`, as descriptors. */
function legacyMethods(refused: ReadonlyMap<string, string | undefined>): SignInMethodItem[] {
  const item = (m: Omit<SignInMethodItem, 'available' | 'reason'>): SignInMethodItem => {
    const reason = refused.get(m.id)
    return refused.has(m.id)
      ? { ...m, available: false, ...(reason === undefined ? {} : { reason }) }
      : { ...m, available: true, ...(m.id === 'password' ? { default: true } : {}) }
  }
  return [
    item({
      id: 'device',
      label: 'Device code',
      assurance: 0,
      interaction: 'poll',
      firstStep: { id: 'device', title: 'Device code', fields: [] },
    }),
    item({
      id: 'password',
      label: 'Password',
      assurance: 2,
      interaction: 'form',
      firstStep: PASSWORD_STEP,
    }),
    item({
      id: 'token',
      label: 'Token',
      assurance: 0,
      interaction: 'form',
      firstStep: {
        id: 'token',
        title: 'Token',
        fields: [{ name: 'token', label: 'Credential', kind: 'secret', mask: true }],
      },
    }),
  ]
}

/** What the flow knows after the core answered `identify`; never a secret. */
interface Flow {
  core: string
  info: SignInCoreInfo
  identifier: string
  /** `undefined` for the three fixed methods of an older core. */
  flowId: string | undefined
  context: AuthZone
  methods: readonly SignInMethodItem[]
  method: SignInMethod
  current: Step
}

/** The method the core marked `default`, else the first available, else the first. */
function firstMethod(methods: readonly SignInMethodItem[]): SignInMethodItem | undefined {
  return (
    methods.find((m) => m.default === true && m.available) ??
    methods.find((m) => m.available) ??
    methods[0]
  )
}

/**
 * The sign-in flow as a small store: address, health check, identifier, the methods the core
 * offers this client, then the step of the chosen method, and the credential is saved the way
 * `keith login` does (through `options.store`; none is kept without one, and none in cookie mode). The controller is generic: it draws no method of its own, it passes on
 * whatever `methods[]`, `firstStep` and `interaction` say (a new method needs no code here while
 * it uses text or secret fields). Pure: the network, the clock and the file come through the
 * options. Secrets are never kept in a state.
 */
export function createSignIn(options: SignInOptions = {}): SignIn {
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const cookie = options.deliver === 'cookie'
  const store: SignInStore = options.store ?? { write: () => undefined }
  const listeners = new Set<(state: SignInState) => void>()

  const initial =
    options.address ??
    (options.socketPath === undefined ? DEFAULT_CORE : `unix:${options.socketPath}`)
  const first = parseSignInAddress(initial)
  let state: SignInState =
    'error' in first
      ? { step: 'address', address: initial, problem: first.error }
      : first.kind === 'unix'
        ? { step: 'socket', address: initial }
        : { step: 'address', address: first.url }

  let disposed = false
  /** Bumped by every new request, cancel and back: an older answer is dropped. */
  let generation = 0
  let controller: AbortController | undefined
  /** The last `/health` answer. */
  let info: SignInCoreInfo = { version: '', sha: '' }
  /** What the user typed in the identifier box (kept across a back, an expiry and a retry). */
  let typed: string | undefined
  let flow: Flow | undefined
  let keepDevice = options.rememberDevice === true

  const set = (next: SignInState): void => {
    state = next
    for (const listener of [...listeners]) listener(state)
  }

  const begin = (): { gen: number; signal: AbortSignal } => {
    controller?.abort()
    generation += 1
    controller = new AbortController()
    return { gen: generation, signal: controller.signal }
  }
  const stale = (gen: number): boolean => disposed || gen !== generation

  const abortAll = (): void => {
    generation += 1
    controller?.abort()
    controller = undefined
  }
  options.signal?.addEventListener('abort', () => dispose())

  const coreOf = (): string | undefined => ('core' in state ? state.core : undefined)

  const problemOf = (
    reason: SignInFailure,
    extra: { message?: string; retryAfter?: number | undefined } = {},
  ): SignInProblem => ({
    reason,
    message: extra.message ?? FAILURE_MESSAGES[reason],
    ...(reason === 'throttled'
      ? {
          retryAt:
            now() + (extra.retryAfter === undefined ? DEFAULT_RETRY_MS : extra.retryAfter * 1000),
        }
      : {}),
  })

  const identifyState = (core: string, problem?: SignInProblem): SignInState => ({
    step: 'identify',
    core,
    info,
    identifier: typed ?? options.remember?.read(core) ?? '',
    ...(problem === undefined ? {} : { problem }),
  })

  const flowState = (f: Flow, problem?: SignInProblem): SignInState => ({
    step: 'flow',
    core: f.core,
    info: f.info,
    identifier: f.identifier,
    context: f.context,
    methods: f.methods,
    method: f.method,
    current: f.current,
    ...(problem === undefined ? {} : { problem }),
  })

  /** The place a cancelled request returns to. */
  const home = (core: string, problem?: SignInProblem): void =>
    set(flow === undefined ? identifyState(core, problem) : flowState(flow, problem))

  async function check(core: string): Promise<void> {
    const { gen, signal } = begin()
    set({ step: 'checking', core })
    let res: Response
    try {
      res = await doFetch(`${core}/health`, { signal })
    } catch (error) {
      if (stale(gen)) return
      set({
        step: 'error',
        core,
        reason: 'unreachable',
        retryable: true,
        message: `cannot reach the core at ${core}: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    const parsed = HealthSchema.safeParse(await res.json().catch(() => undefined))
    if (stale(gen)) return
    if (!res.ok && res.status >= 500) {
      set({
        step: 'error',
        core,
        reason: 'unreachable',
        retryable: true,
        message: `the core answered ${res.status}`,
      })
      return
    }
    if (!parsed.success) {
      set({
        step: 'error',
        core,
        reason: 'not_keith',
        retryable: true,
        message: FAILURE_MESSAGES.not_keith,
      })
      return
    }
    info = { version: parsed.data.version, sha: parsed.data.sha }
    flow = undefined
    set(identifyState(core))
  }

  /** `GET /auth/methods` of an older core; any failure keeps all three methods offered. */
  async function legacyList(core: string, signal: AbortSignal): Promise<SignInMethodItem[]> {
    const refused = new Map<string, string | undefined>()
    try {
      const res = await doFetch(`${core}/auth/methods`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(METHODS_TIMEOUT_MS)]),
      })
      if (res.ok) {
        const parsed = AuthMethodsSchema.safeParse(await res.json())
        if (parsed.success)
          for (const m of parsed.data.methods) if (!m.available) refused.set(m.id, m.reason)
      }
    } catch {
      // keep all three offered: a refusal comes when one is tried
    }
    return legacyMethods(refused)
  }

  async function whoOf(
    core: string,
    token: string | undefined,
    signal: AbortSignal,
  ): Promise<SignInPerson | undefined> {
    if (signal.aborted) return undefined
    const client = createKeithClient({
      baseUrl: core,
      ...(token === undefined ? {} : { token }),
      fetch: doFetch,
    })
    const answer = client.rpc.auth.whoami().then(
      (me): SignInPerson => ({ name: me.name, username: me.username, role: me.role }),
      () => undefined,
    )
    const timer = new AbortController()
    const timeout = sleep(options.whoamiTimeoutMs ?? WHOAMI_TIMEOUT_MS, timer.signal).then(
      () => undefined,
    )
    // a cancel or back ends the wait at once; the caller then keeps nothing
    const cancelled = new Promise<undefined>((resolve) => {
      signal.addEventListener('abort', () => resolve(undefined), { once: true })
    })
    const result = await Promise.race([answer, timeout, cancelled])
    timer.abort()
    return signal.aborted ? undefined : result
  }

  /**
   * Revoke a credential the controller will not keep (a cancel during the check, a save that failed), best effort.
   * The person never saw it as signed in, so nothing waits for the answer.
   */
  function revokeQuietly(core: string, credential: string | undefined): void {
    if (credential === undefined) {
      void endWebSession({ core, fetch: doFetch }).catch(() => undefined)
      return
    }
    void createKeithClient({ baseUrl: core, token: credential, fetch: doFetch })
      .revokeSelf()
      .catch(() => undefined)
  }

  /**
   * Keep the credential of a sign-in only while the person is still there (FD10-14). `auth.whoami` is asked first,
   * with the credential in memory (3 s at most; a timeout still saves, the core accepted the login moments ago).
   * A cancel or back during that wait stores nothing and revokes the fresh credential. A store that throws (it
   * removes what it wrote) revokes it too, then reports `save_failed`.
   */
  async function finish(
    f: Flow,
    credential: string | undefined,
    gen: number,
    signal: AbortSignal,
    checked?: SignInPerson,
    remembered = false,
  ): Promise<void> {
    const person = checked ?? (await whoOf(f.core, credential, signal))
    if (stale(gen)) {
      revokeQuietly(f.core, credential)
      return
    }
    let note: string | undefined
    try {
      // a cookie session has nothing to keep: the browser holds it
      if (credential !== undefined) {
        const saved = await store.write({
          core: f.core,
          token: credential,
          ...(remembered ? { remember: true } : {}),
        })
        note = typeof saved === 'string' ? saved : undefined
      }
    } catch {
      revokeQuietly(f.core, credential)
      set(flowState(f, problemOf('save_failed')))
      return
    }
    if (f.identifier !== '') options.remember?.write(f.core, f.identifier)
    set({ step: 'done', core: f.core, person, ...(note === undefined ? {} : { note }) })
  }

  /** A pasted credential: checked through `auth.whoami`, saved only when the core accepts it. */
  async function submitToken(f: Flow, token: string): Promise<void> {
    const { gen, signal } = begin()
    set({ step: 'working', core: f.core, method: f.method })
    try {
      const me = await createKeithClient({
        baseUrl: f.core,
        token,
        fetch: doFetch,
      }).rpc.auth.whoami()
      if (stale(gen)) return
      const person = { name: me.name, username: me.username, role: me.role }
      if (cookie) {
        // the token is sent once, to be turned into the cookie; the page never keeps it
        await adoptSession({
          core: f.core,
          credential: token,
          remember: keepDevice,
          fetch: doFetch,
        })
        if (stale(gen)) {
          revokeQuietly(f.core, undefined)
          return
        }
        await finish(f, undefined, gen, signal, person, keepDevice)
        return
      }
      await finish(f, token, gen, signal, person)
    } catch (error) {
      if (stale(gen)) return
      const status = (error as { status?: unknown; code?: unknown } | null) ?? {}
      const unauthorized =
        status.status === 401 ||
        status.code === 'UNAUTHORIZED' ||
        (error instanceof WebSessionError && error.reason === 'invalid')
      set(
        flowState(
          f,
          problemOf(unauthorized ? 'invalid' : 'unreachable', {
            message: unauthorized
              ? 'the core does not accept this token'
              : `cannot reach the core at ${f.core}`,
          }),
        ),
      )
    }
  }

  /** The three fixed methods of an older core: the identifier is the username. */
  async function legacyPassword(f: Flow, password: string): Promise<void> {
    const { gen, signal } = begin()
    set({ step: 'working', core: f.core, method: f.method })
    if (cookie) {
      set(
        flowState(
          f,
          problemOf('rejected', { message: 'this core is too old for a browser sign-in' }),
        ),
      )
      return
    }
    let credential: string
    try {
      credential = await passwordLogin({
        core: f.core,
        username: f.identifier,
        password,
        fetch: doFetch,
        ...(options.label === undefined ? {} : { label: options.label }),
      })
    } catch (error) {
      if (stale(gen)) return
      if (error instanceof LoginError) {
        set(
          flowState(
            f,
            problemOf(error.reason, {
              retryAfter: error.retryAfter,
              ...(error.reason === 'unreachable'
                ? { message: `cannot reach the core at ${f.core}` }
                : {}),
            }),
          ),
        )
      } else set(flowState(f, problemOf('unreachable')))
      return
    }
    if (stale(gen)) return
    await finish(f, credential, gen, signal)
  }

  async function startDevice(f: Flow): Promise<void> {
    const { gen, signal } = begin()
    set({ step: 'device', core: f.core, code: undefined, expiresAt: undefined, polling: false })
    try {
      const result = await deviceLoginResult({
        core: f.core,
        ...(cookie ? { deliver: 'cookie' as const } : {}),
        signal,
        fetch: doFetch,
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
        onCode: ({ code, expiresAt }) => {
          if (!stale(gen)) set({ step: 'device', core: f.core, code, expiresAt, polling: true })
        },
      })
      if (stale(gen)) return
      set({ step: 'working', core: f.core, method: 'device' })
      await finish(f, 'credential' in result ? result.credential : undefined, gen, signal)
    } catch (error) {
      if (stale(gen)) return
      if (error instanceof DeviceLoginError) {
        if (error.reason === 'aborted') return
        set(
          flowState(
            f,
            problemOf(error.reason, {
              ...(error.reason === 'unreachable'
                ? { message: `cannot reach the core at ${f.core}` }
                : {}),
            }),
          ),
        )
        return
      }
      set(flowState(f, problemOf('unreachable')))
    }
  }

  /** The state a failed answer leads to. The words are the same whoever was typed. */
  function afterFailure(
    f: Flow,
    outcome: Exclude<AnswerOutcome, { kind: 'credential' | 'cookie' | 'step' }>,
  ) {
    switch (outcome.kind) {
      case 'expired':
        // the flow is gone: ask again, keeping what was typed
        flow = undefined
        typed = f.identifier
        set(
          identifyState(f.core, {
            reason: 'expired',
            message: 'the sign-in timed out: enter your id again',
          }),
        )
        return
      case 'invalid':
        return set(flowState(f, problemOf('invalid')))
      case 'not_allowed_here':
        return set(flowState(f, problemOf('not_allowed_here')))
      case 'throttled':
        return set(flowState(f, problemOf('throttled', { retryAfter: outcome.retryAfter })))
      case 'unavailable':
        return set(flowState(f, problemOf('unavailable')))
      case 'rejected':
        return set(flowState(f, problemOf('rejected')))
      case 'unreachable':
        return set(
          flowState(f, problemOf('unreachable', { message: `cannot reach the core at ${f.core}` })),
        )
    }
  }

  async function answer(f: Flow, flowId: string, values: Readonly<Record<string, string>>) {
    const { gen, signal } = begin()
    set({ step: 'working', core: f.core, method: f.method })
    const body = {
      ...(options.label === undefined ? {} : { label: options.label }),
      ...values,
    }
    const remember = keepDevice
    const outcome = await requestAnswer(
      f.core,
      flowId,
      f.method,
      body,
      doFetch,
      signal,
      remember,
      cookie ? 'cookie' : 'body',
    )
    if (stale(gen)) return
    if (outcome.kind === 'cookie') return finish(f, undefined, gen, signal, undefined, remember)
    if (outcome.kind === 'credential')
      return finish(f, outcome.credential, gen, signal, undefined, remember)
    if (outcome.kind === 'step') {
      f.current = outcome.step
      return set(flowState(f))
    }
    afterFailure(f, outcome)
  }

  const self: SignIn = {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async submitAddress(address) {
      if (disposed) return
      const parsed = parseSignInAddress(address)
      if ('error' in parsed) {
        abortAll()
        set({ step: 'address', address, problem: parsed.error })
        return
      }
      if (parsed.kind === 'unix') {
        abortAll()
        set({ step: 'socket', address: `unix:${parsed.path}` })
        return
      }
      await check(parsed.url)
    },
    async submitIdentifier(identifier) {
      if (disposed || state.step !== 'identify') return
      const { core } = state
      const text = identifier.trim()
      typed = identifier
      if (text === '') {
        set(
          identifyState(core, {
            reason: 'invalid',
            message: 'type your id, username, email or phone',
          }),
        )
        return
      }
      if (state.problem?.retryAt !== undefined && state.problem.retryAt > now()) return
      typed = text
      flow = undefined
      const { gen, signal } = begin()
      set({ step: 'working', core, method: undefined })
      const outcome = await requestIdentify(core, text, doFetch, signal)
      if (stale(gen)) return
      if (outcome.kind === 'ok' || outcome.kind === 'legacy') {
        const legacy = outcome.kind === 'legacy'
        const methods = legacy ? await legacyList(core, signal) : outcome.methods
        if (stale(gen)) return
        const chosen = firstMethod(methods)
        if (chosen === undefined) {
          set(identifyState(core, problemOf('not_allowed_here')))
          return
        }
        flow = {
          core,
          info,
          identifier: text,
          flowId: legacy ? undefined : (outcome as { flowId: string }).flowId,
          context: legacy ? 'public' : (outcome as { context: AuthZone }).context,
          methods,
          method: chosen.id,
          current: chosen.firstStep,
        }
        set(flowState(flow))
        return
      }
      const reason: SignInFailure =
        outcome.kind === 'throttled'
          ? 'throttled'
          : outcome.kind === 'unavailable'
            ? 'unavailable'
            : outcome.kind === 'rejected'
              ? 'rejected'
              : 'unreachable'
      set(
        identifyState(
          core,
          problemOf(reason, {
            ...(outcome.kind === 'throttled' ? { retryAfter: outcome.retryAfter } : {}),
            ...(reason === 'unreachable' ? { message: `cannot reach the core at ${core}` } : {}),
          }),
        ),
      )
    },
    setRememberDevice(on) {
      keepDevice = on
    },
    rememberDevice: () => keepDevice,
    canRememberDevice() {
      if (disposed || state.step !== 'flow' || flow?.flowId === undefined) return false
      const chosen = flow.methods.find((m) => m.id === flow?.method)
      return chosen?.available === true && chosen.interaction !== 'poll' && chosen.id !== 'token'
    },
    chooseMethod(method) {
      if (disposed || state.step !== 'flow' || flow === undefined) return
      const chosen = flow.methods.find((m) => m.id === method)
      if (chosen === undefined) return
      flow.method = chosen.id
      flow.current = chosen.firstStep
      set(flowState(flow))
    },
    async submitStep(values) {
      if (disposed || state.step !== 'flow' || flow === undefined) return
      const f = flow
      const chosen = f.methods.find((m) => m.id === f.method)
      if (chosen === undefined) return
      if (!chosen.available) {
        set(
          flowState(
            f,
            problemOf('not_allowed_here', {
              message: chosen.reason ?? FAILURE_MESSAGES.not_allowed_here,
            }),
          ),
        )
        return
      }
      if (state.problem?.retryAt !== undefined && state.problem.retryAt > now()) return
      if (chosen.interaction === 'poll') return startDevice(f)
      // an empty field is never sent
      if (f.current.fields.some((field) => (values[field.name] ?? '') === '')) return
      if (f.method === 'token') {
        const name = f.current.fields[0]?.name
        return submitToken(f, name === undefined ? '' : (values[name] ?? ''))
      }
      if (f.flowId === undefined) return legacyPassword(f, values.password ?? '')
      return answer(f, f.flowId, values)
    },
    cancel() {
      if (disposed) return
      abortAll()
      const core = coreOf()
      if (state.step === 'device' || state.step === 'working') {
        if (core !== undefined) home(core)
      } else if (state.step === 'checking') {
        set({ step: 'address', address: state.core })
      }
    },
    back() {
      if (disposed) return
      switch (state.step) {
        case 'flow':
          abortAll()
          typed = state.identifier
          flow = undefined
          set(identifyState(state.core))
          return
        case 'identify':
          abortAll()
          set({ step: 'address', address: state.core })
          return
        case 'device':
        case 'working':
        case 'checking':
          self.cancel()
          return
        case 'error':
          set({ step: 'address', address: state.core })
          return
        default:
          return
      }
    },
    async retry() {
      if (disposed || state.step !== 'error' || !state.retryable) return
      return check(state.core)
    },
    dispose,
  }

  function dispose(): void {
    if (disposed) return
    abortAll()
    disposed = true
    listeners.clear()
  }

  return self
}

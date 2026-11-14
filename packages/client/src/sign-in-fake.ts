import { expect } from 'bun:test'
import type { MethodDescriptor } from '@keith/contracts'
import {
  createSignIn,
  type SignIn,
  type SignInOptions,
  type SignInState,
  type SignInStore,
} from './sign-in.ts'

/** Helpers of the sign-in controller tests: a fake core keyed by path, fixtures, a state tracker. */
export const CORE = 'http://core.test'
export const HEALTH = { status: 'ok', version: '1.2.3', sha: 'abc1234', boot: 'b1' }
export const WHOAMI = {
  personId: 'p1',
  name: 'Ana Lopez',
  username: 'ana',
  role: 'owner',
  via: 'tcp',
  credentialKind: 'device',
  elevated: false,
  capabilities: [],
}

// Fake secrets built at runtime (gitleaks flags key-shaped literals).
export const PASSWORD = ['pw', 'zebra', 'quartz', String(7391)].join('-')
export const PIN = ['4', '8', '1', '5', '9', '2'].join('')
export const TOKEN = ['tok', 'walrus', 'ember', String(4482)].join('_')
export const CREDENTIAL = ['cred', 'falcon', 'maple', String(2210)].join('_')

export type Reply = Response | 'network' | (() => Response | Promise<Response>)
export type Script = Record<string, Reply | Reply[]>

/** A fake core keyed by path; an array answers one entry per call (the last one repeats). */
export function fakeCore(script: Script) {
  const calls: Array<{ path: string; body: string; auth: string | null }> = []
  const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const path = new URL(request?.url ?? String(input)).pathname
    const headers = new Headers(request?.headers ?? init?.headers)
    calls.push({
      path,
      body: String(init?.body ?? (request === undefined ? '' : await request.clone().text())),
      auth: headers.get('authorization'),
    })
    const entry = script[path] ?? script[path.replace(/^(\/auth\/flow\/)[^/]+$/, '$1:id')]
    if (entry === undefined) return new Response('{}', { status: 404 })
    const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry
    if (reply === undefined || reply === 'network') throw new Error('offline')
    if (init?.signal?.aborted) throw new Error('aborted')
    return typeof reply === 'function' ? reply() : reply.clone()
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}

export const whoamiOk = () => Response.json({ json: WHOAMI })
export const unauthorized = () =>
  Response.json(
    {
      json: {
        defined: false,
        code: 'UNAUTHORIZED',
        status: 401,
        message: 'Unauthorized',
        data: {},
      },
    },
    { status: 401 },
  )
export const health = () => Response.json(HEALTH)

const REASON = 'not accepted from this network: use a private network address or the device code'

const pinMethod = (available: boolean): MethodDescriptor => ({
  id: 'pin',
  label: 'PIN',
  available,
  ...(available ? {} : { reason: REASON }),
  assurance: 1,
  interaction: 'form',
  firstStep: {
    id: 'pin',
    title: 'PIN',
    fields: [{ name: 'pin', label: 'PIN', kind: 'digits', mask: true, length: 12 }],
  },
})
const passwordMethod = (available: boolean): MethodDescriptor => ({
  id: 'password',
  label: 'Password',
  available,
  ...(available ? {} : { reason: REASON }),
  assurance: 2,
  interaction: 'form',
  firstStep: {
    id: 'password',
    title: 'Password',
    fields: [{ name: 'password', label: 'Password', kind: 'secret', mask: true }],
  },
})
const deviceMethod: MethodDescriptor = {
  id: 'device',
  label: 'Device code',
  available: true,
  assurance: 0,
  interaction: 'poll',
  firstStep: { id: 'device', title: 'Device code', fields: [] },
}
const tokenMethod: MethodDescriptor = {
  id: 'token',
  label: 'Token',
  available: true,
  assurance: 0,
  interaction: 'form',
  firstStep: {
    id: 'token',
    title: 'Token',
    fields: [{ name: 'token', label: 'Credential', kind: 'secret', mask: true }],
  },
}

/** An `identify` answer; `pin` and `password` say what the zone allows (the core marks the default). */
export function identifyReply(
  context: 'loopback' | 'lan' | 'tailscale' | 'public',
  allow: { pin: boolean; password: boolean } = { pin: true, password: true },
  flowId = 'flow-1',
): () => Response {
  const pin = pinMethod(allow.pin)
  const password = passwordMethod(allow.password)
  const methods = [deviceMethod, pin, password, tokenMethod].map((m) => ({ ...m }))
  const def = allow.pin ? 'pin' : allow.password ? 'password' : undefined
  return () =>
    Response.json({
      flowId,
      context,
      methods: methods.map((m) => (m.id === def ? { ...m, default: true } : m)),
    })
}

export function memoryStore() {
  const writes: Array<{ core: string; token: string; remember?: true }> = []
  const store: SignInStore = { write: (config) => void writes.push({ ...config }) }
  return { store, writes }
}

/** Run a sign-in with a state history, so a test can inspect every snapshot. */
export function track(options: SignInOptions) {
  const signIn = createSignIn(options)
  const history: SignInState[] = [signIn.get()]
  signIn.subscribe((s) => history.push(s))
  return { signIn, history }
}

/** `address -> checking -> identify`. */
export async function atIdentify(signIn: SignIn): Promise<void> {
  await signIn.submitAddress(CORE)
  expect(signIn.get().step).toBe('identify')
}

/** `... -> identify -> flow` for `who`. */
export async function atFlow(signIn: SignIn, who = 'ana'): Promise<void> {
  await atIdentify(signIn)
  await signIn.submitIdentifier(who)
  expect(signIn.get().step).toBe('flow')
}

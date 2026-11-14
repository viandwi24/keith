import type { FakeAuth, FakeFlow } from './fake-core-types.ts'
import { createFlow } from './fake-flow.ts'

/** A credential in the shape of a session one, built at runtime (secret scanners flag literals). */
export const FAKE_CREDENTIAL = ['keith', 's', 'fake'].join('_')

type Device = 'pending' | 'approved' | 'denied' | 'expired'

/**
 * The sign-in half of the fake core: `GET /auth/methods`, `POST /auth/login` and the device-code
 * start and poll routes. `onSignedIn` runs when a credential is issued (the core accepts requests
 * again); the fake core answers these routes even while the credential is revoked.
 */
export function createAuth(
  options: FakeAuth = {},
  onSignedIn: () => void = () => {},
  flowOptions?: FakeFlow,
) {
  const flow = flowOptions === undefined ? undefined : createFlow(flowOptions, onSignedIn)
  let device: Device = 'pending'
  const logins: Array<{ username: string; label?: string }> = []
  const devices: Array<{ label?: string }> = []
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    Response.json(body, { status, headers })
  return {
    logins,
    devices,
    identified: flow?.identified ?? [],
    flowAnswers: flow?.answered ?? [],
    firstOwnerSets: flow?.firstOwnerSets ?? [],
    setDevice(next: Device): void {
      device = next
    },
    async handle(request: Request, path: string): Promise<Response | undefined> {
      const flowed = await flow?.handle(request, path)
      if (flowed !== undefined) return flowed
      if (path === '/auth/methods')
        return json({
          methods: options.methods ?? [
            { id: 'device', available: true },
            { id: 'password', available: true },
            { id: 'token', available: true },
          ],
        })
      if (path === '/auth/login' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as {
          username?: string
          password?: string
          label?: string
        }
        logins.push({
          username: body.username ?? '',
          ...(body.label === undefined ? {} : { label: body.label }),
        })
        if (options.throttle !== undefined)
          return json({ error: 'throttled', retryAfter: options.throttle }, 429, {
            'retry-after': String(options.throttle),
          })
        const ok =
          options.password !== undefined &&
          body.username === options.password.username &&
          body.password === options.password.password
        if (!ok) return json({ error: 'invalid' }, 401)
        onSignedIn()
        return json({ credential: FAKE_CREDENTIAL })
      }
      if (path === '/auth/device/start' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { label?: string }
        devices.push(body.label === undefined ? {} : { label: body.label })
        device = 'pending'
        return json({
          code: 'KTPW-4C7M',
          requestId: 'req-1',
          expiresAt: Date.now() + 5 * 60_000,
          pollSecret: ['poll', 'secret'].join('-'),
        })
      }
      if (path === '/auth/device/poll' && request.method === 'POST') {
        if (device === 'approved') {
          onSignedIn()
          return json({ status: 'approved', credential: FAKE_CREDENTIAL })
        }
        return json({ status: device })
      }
      return undefined
    },
  }
}

import type { FakeFlow } from './fake-core-types.ts'

/** A credential in the shape of a session one, built at runtime (secret scanners flag literals). */
const CREDENTIAL = ['keith', 's', 'fake'].join('_')

const METHODS = (flow: FakeFlow) => {
  const pin = flow.pin !== false
  const password = flow.password !== false
  const refusal = 'not accepted from this network: use the password or the device code'
  const def = pin ? 'pin' : password ? 'password' : undefined
  const list = [
    {
      id: 'device',
      label: 'Device code',
      available: true,
      assurance: 0,
      interaction: 'poll',
      firstStep: { id: 'device', title: 'Device code', fields: [] },
    },
    {
      id: 'pin',
      label: 'PIN',
      available: pin,
      ...(pin ? {} : { reason: refusal }),
      assurance: 1,
      interaction: 'form',
      firstStep: {
        id: 'pin',
        title: 'PIN',
        fields: [{ name: 'pin', label: 'PIN', kind: 'digits', mask: true, length: 12 }],
      },
    },
    {
      id: 'password',
      label: 'Password',
      available: password,
      ...(password ? {} : { reason: refusal }),
      assurance: 2,
      interaction: 'form',
      firstStep: {
        id: 'password',
        title: 'Password',
        fields: [{ name: 'password', label: 'Password', kind: 'secret', mask: true }],
      },
    },
    {
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
    },
  ]
  return list.map((m) => (m.id === def ? { ...m, default: true } : m))
}

/**
 * The identifier-first half of the fake core: `POST /auth/identify` and `POST /auth/flow/:id`.
 * An unknown identifier gets the same answer as a known one (a decoy), and a wrong secret the same
 * 401, like the real core. It records the identifiers and the methods answered, never a secret.
 */
export function createFlow(flow: FakeFlow, onSignedIn: () => void) {
  const identified: string[] = []
  const answered: Array<{ identifier: string; method: string; remember?: true }> = []
  const firstOwnerSets: number[] = []
  let firstOwnerOpen = flow.firstOwner === true
  const flows = new Map<string, string>()
  let n = 0
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    Response.json(body, { status, headers })
  return {
    identified,
    answered,
    firstOwnerSets,
    async handle(request: Request, path: string): Promise<Response | undefined> {
      if (
        flow.firstOwner !== undefined &&
        path === '/auth/local/status' &&
        request.method === 'GET'
      )
        return json({ needsFirstOwner: firstOwnerOpen })
      if (
        flow.firstOwner !== undefined &&
        path === '/auth/local/first-owner' &&
        request.method === 'POST'
      ) {
        const body = (await request.json().catch(() => ({}))) as { pin?: string }
        if (!firstOwnerOpen) return json({ error: 'not_available' }, 409)
        if (!/^\d{6,12}$/.test(body.pin ?? ''))
          return json({ error: 'bad_secret', hint: 'a PIN is 6 to 12 digits' }, 400)
        firstOwnerOpen = false
        firstOwnerSets.push(1)
        flow.people.owner = { pin: body.pin as string }
        onSignedIn()
        return json({ credential: CREDENTIAL })
      }
      if (request.method !== 'POST') return undefined
      if (path === '/auth/identify') {
        const body = (await request.json().catch(() => ({}))) as { identifier?: string }
        const identifier = (body.identifier ?? '').trim()
        identified.push(identifier)
        const flowId = `fake-flow-${++n}`
        flows.set(flowId, identifier)
        return json({ flowId, context: flow.context ?? 'loopback', methods: METHODS(flow) })
      }
      const match = /^\/auth\/flow\/([^/]+)$/.exec(path)
      if (match === null) return undefined
      const identifier = flows.get(match[1] ?? '')
      if (identifier === undefined) return json({ error: 'not_found' }, 404)
      const body = (await request.json().catch(() => ({}))) as {
        method?: string
        answer?: Record<string, string>
        remember?: boolean
      }
      answered.push({
        identifier,
        method: body.method ?? '',
        ...(body.remember === true ? { remember: true as const } : {}),
      })
      if (flow.throttle !== undefined)
        return json({ error: 'throttled', retryAfter: flow.throttle }, 429, {
          'retry-after': String(flow.throttle),
        })
      const person = flow.people[identifier]
      const secret = body.method === 'pin' ? body.answer?.pin : body.answer?.password
      const wanted = body.method === 'pin' ? person?.pin : person?.password
      if (wanted === undefined || secret !== wanted)
        return json({ error: 'invalid_credentials' }, 401)
      onSignedIn()
      return json({ credential: CREDENTIAL })
    },
  }
}

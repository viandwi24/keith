// The Web Push service (docs/specs/push.md): the subscriptions of a person, the `push.preview` setting, and the delivery route
// that sends a push. The sender, the repo and the audit are injected.
import {
  type DeliveryRequest,
  PUSH_SUBSCRIPTIONS_PER_PERSON_MAX,
  type PushPayload,
  type PushRecord,
  type PushSubscribe,
  PushSubscribeSchema,
  type PushUnsubscribe,
} from '@keith/contracts'
import type { PushSubscriptionRow, PushSubscriptionsRepo } from '@keith/db'
import type { Audit } from '../audit/index.ts'
import type { DeliveryRoute } from '../delivery/index.ts'
import type { PushSender } from './sender.ts'

/** A refusal the procedures turn into the oRPC error of the same code. */
export class PushError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'PushError'
  }
}

/** Consecutive failed sends after which a subscription is dropped. */
export const MAX_FAILURES = 5
/** The neutral body: no message text leaves the core unless the person turned `push.preview` on. */
export const NEUTRAL_BODY = 'Keith has something for you'
/** Characters of the text a preview push carries (one line). */
export const PREVIEW_MAX = 140

export const previewSetting = (personId: string): string => `push.preview.${personId}`

export interface PushServiceDeps {
  repo: PushSubscriptionsRepo
  settings: {
    get<T>(key: string): T | undefined
    set(key: string, value: unknown): void
    delete(key: string): void
  }
  sender: PushSender
  /** The VAPID public key, base64url. */
  publicKey: string
  audit: Pick<Audit, 'record'>
  now?: () => number
  newId?: () => string
  warn?: (message: string) => void
  maxFailures?: number
}

export interface PushService {
  publicKey(): string
  subscribe(personId: string, input: PushSubscribe): PushRecord
  /** Idempotent: an id or endpoint that is not this person's subscription does nothing. */
  unsubscribe(personId: string, input: PushUnsubscribe): void
  list(personId: string): PushRecord[]
  hasSubscriptions(personId: string): boolean
  preview(personId: string): boolean
  setPreview(personId: string, preview: boolean): boolean
  /** The push route of one person: every subscription gets the delivery once. It never replaces the front session. */
  route(personId: string): DeliveryRoute
  /** The data of a removed person: their subscriptions and the setting. */
  purge(personId: string): void
}

const recordOf = (row: PushSubscriptionRow): PushRecord => ({
  id: row.id,
  clientId: row.clientId,
  label: row.label,
  userAgent: row.userAgent,
  createdAt: row.createdAt,
  lastSuccessAt: row.lastSuccessAt,
  failures: row.failureCount,
})

/**
 * An endpoint the core may POST to: https, a public-looking host name (not an IP literal, `localhost` or a name without a
 * dot). A push service is a public host; this keeps a signed-in person from aiming the core at its own network.
 */
export function isPublicEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (host.startsWith('[') || /^[0-9.]+$/.test(host)) return false
  if (!host.includes('.')) return false
  return !['.local', '.localhost', '.internal', '.lan', '.home.arpa'].some((s) => host.endsWith(s))
}

/** The notification a delivery makes: neutral unless `preview`, and a deep link to the app (or its inbox for an approval). */
export function payloadOf(request: DeliveryRequest, preview: boolean): PushPayload {
  const approval = request.name === 'approval' || request.source.startsWith('approval')
  const text = request.text.replace(/\s+/g, ' ').trim()
  return {
    title: 'Keith',
    body: preview && text !== '' ? text.slice(0, PREVIEW_MAX) : NEUTRAL_BODY,
    url: approval ? '/app/inbox' : '/app',
    tag: request.id.slice(0, 100),
  }
}

export function createPushService(deps: PushServiceDeps): PushService {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const maxFailures = deps.maxFailures ?? MAX_FAILURES
  /** Delivery ids already pushed (a retry of the front route must not push again); bounded. */
  const pushed = new Set<string>()
  const remember = (id: string): void => {
    pushed.add(id)
    if (pushed.size > 500) pushed.delete(pushed.values().next().value as string)
  }

  async function sendOne(row: PushSubscriptionRow, request: DeliveryRequest, body: string) {
    const result = await deps.sender.send(row, body, { urgency: request.needs.urgency })
    if (result.ok) deps.repo.markSuccess(row.id, now())
    else if (result.gone) deps.repo.delete(row.id)
    else if ((deps.repo.markFailure(row.id) ?? 0) >= maxFailures) deps.repo.delete(row.id)
    // the audit row names the subscription, never the endpoint
    deps.audit.record({
      kind: 'delivery.push',
      actor: 'system',
      via: 'local',
      detail: {
        id: request.id,
        source: request.source,
        to: row.personId,
        subscription: row.id,
        ok: result.ok,
        status: result.status,
      },
    })
    return result.ok
  }

  return {
    publicKey: () => deps.publicKey,
    subscribe(personId, rawInput) {
      const input = PushSubscribeSchema.parse(rawInput)
      const { endpoint, keys } = input.subscription
      if (!isPublicEndpoint(endpoint))
        throw new PushError('BAD_REQUEST', 'push endpoint must be a public https URL')
      const existing = deps.repo.byEndpoint(endpoint)
      if (
        existing?.personId !== personId &&
        deps.repo.countFor(personId) >= PUSH_SUBSCRIPTIONS_PER_PERSON_MAX
      )
        throw new PushError(
          'CONFLICT',
          `at most ${PUSH_SUBSCRIPTIONS_PER_PERSON_MAX} push subscriptions per person`,
        )
      const row = deps.repo.upsert({
        id: newId(),
        personId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        clientId: input.clientId ?? null,
        label: input.label,
        userAgent: input.userAgent,
        createdAt: now(),
      })
      return recordOf(row)
    },
    unsubscribe(personId, input) {
      const row =
        input.id !== undefined
          ? deps.repo.get(input.id)
          : deps.repo.byEndpoint(input.endpoint as string)
      if (row !== undefined && row.personId === personId) deps.repo.delete(row.id)
    },
    list: (personId) => deps.repo.listFor(personId).map(recordOf),
    hasSubscriptions: (personId) => deps.repo.countFor(personId) > 0,
    preview: (personId) => deps.settings.get<boolean>(previewSetting(personId)) === true,
    setPreview(personId, preview) {
      if (preview) deps.settings.set(previewSetting(personId), true)
      else deps.settings.delete(previewSetting(personId))
      return preview
    },
    route(personId) {
      return {
        id: 'push',
        companion: true,
        async send(request) {
          // already pushed for this delivery (the front route is retried): no second notification
          if (pushed.has(request.id)) return { ok: true }
          const rows = deps.repo.listFor(personId)
          if (rows.length === 0) return { ok: false, reason: 'unavailable' }
          const preview = deps.settings.get<boolean>(previewSetting(personId)) === true
          const body = JSON.stringify(payloadOf(request, preview))
          const results = await Promise.all(rows.map((row) => sendOne(row, request, body)))
          if (!results.some(Boolean)) return { ok: false, reason: 'unavailable' }
          remember(request.id)
          return { ok: true }
        },
      }
    },
    purge(personId) {
      deps.repo.deleteFor(personId)
      deps.settings.delete(previewSetting(personId))
    },
  }
}

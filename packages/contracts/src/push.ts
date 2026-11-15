import { z } from 'zod'

/**
 * Web Push (docs/specs/push.md, ADR-0035): a browser subscribes with its push service and the core keeps the subscription
 * of the signed-in person. The endpoint and the keys are secrets of the subscription: no read shows them back.
 */

/** Most characters of a push endpoint URL (push services use a few hundred). */
export const PUSH_ENDPOINT_MAX = 2048
/** Most subscriptions one person may keep (the 11th is refused; an endpoint already stored is updated, not counted). */
export const PUSH_SUBSCRIPTIONS_PER_PERSON_MAX = 10

/** An https URL: a push service never speaks plain http. */
const httpsUrl = z
  .string()
  .max(PUSH_ENDPOINT_MAX)
  .refine((v) => {
    try {
      const url = new URL(v)
      return url.protocol === 'https:' && url.username === '' && url.password === ''
    } catch {
      return false
    }
  }, 'push endpoint must be an https URL')

/** The browser's `PushSubscription.toJSON()`: `p256dh` is a 65-byte P-256 point and `auth` 16 bytes, base64url without padding. */
export const PushSubscriptionSchema = z.object({
  endpoint: httpsUrl,
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{86,88}$/, 'p256dh must be 65 bytes of base64url'),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22,24}$/, 'auth must be 16 bytes of base64url'),
  }),
})
export type PushSubscriptionJson = z.infer<typeof PushSubscriptionSchema>

/** Input of `presence.push.subscribe`: the subscription, the id of the client that made it and two labels. */
export const PushSubscribeSchema = z.object({
  subscription: PushSubscriptionSchema,
  /** The presence client id of this browser (a uuid), when it has one. */
  clientId: z.string().uuid().optional(),
  label: z.string().max(60).default(''),
  userAgent: z.string().max(300).default(''),
})
export type PushSubscribe = z.input<typeof PushSubscribeSchema>

/** A stored subscription as the owner reads it: never the endpoint or the keys. */
export const PushRecordSchema = z.object({
  id: z.string(),
  clientId: z.string().nullable(),
  label: z.string(),
  userAgent: z.string(),
  createdAt: z.number(),
  lastSuccessAt: z.number().nullable(),
  failures: z.number().int(),
})
export type PushRecord = z.infer<typeof PushRecordSchema>

/** Input of `presence.push.unsubscribe`: the subscription id, or its endpoint (what a browser still knows). */
export const PushUnsubscribeSchema = z
  .object({ id: z.string().min(1).max(100).optional(), endpoint: httpsUrl.optional() })
  .refine((v) => v.id !== undefined || v.endpoint !== undefined, 'give an id or an endpoint')
export type PushUnsubscribe = z.infer<typeof PushUnsubscribeSchema>

/** `presence.push.publicKey`: the VAPID public key, an uncompressed P-256 point in base64url (the `applicationServerKey`). */
export const PushPublicKeySchema = z.object({ publicKey: z.string() })
export type PushPublicKey = z.infer<typeof PushPublicKeySchema>

/** The per-person setting `push.preview`: false (the default) sends a payload with no message text. */
export const PushPreviewSchema = z.object({ preview: z.boolean() })
export type PushPreview = z.infer<typeof PushPreviewSchema>

/** What the service worker receives (the JSON a push carries, spec push.md "Payload"). */
export const PushPayloadSchema = z.object({
  title: z.string(),
  body: z.string(),
  url: z.string(),
  tag: z.string(),
})
export type PushPayload = z.infer<typeof PushPayloadSchema>

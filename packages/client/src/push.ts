// Web Push on the client (docs/specs/push.md, "Client"): the four `presence.push.*` calls of the caller's own subscriptions.
// Browser-safe: no Node or Bun API (browser.test.ts walks the import graph). The service worker and `pushManager` are the
// web app's; this file only talks to the core.
import type { PushRecord, PushSubscriptionJson } from '@keith/contracts'
import type { KeithClient } from './client.ts'

/** A browser `PushSubscription` or its JSON: `subscribePush` takes either. */
export type PushSubscriptionLike = PushSubscriptionJson | { toJSON(): unknown }

/** What `subscribePush` sends besides the subscription. */
export interface SubscribePushOptions {
  /** The presence client id of this browser (a uuid). */
  clientId?: string
  /** The user agent label, e.g. `navigator.userAgent`; clipped to 300 characters. */
  userAgent?: string
}

type RpcClient = Pick<KeithClient, 'rpc'>

/** The VAPID public key (base64url) the browser subscribes with (`applicationServerKey`). */
export async function pushPublicKey(client: RpcClient): Promise<string> {
  return (await client.rpc.presence.push.publicKey()).publicKey
}

/** The `applicationServerKey` bytes of a VAPID public key (what `pushManager.subscribe` wants). */
export function applicationServerKeyOf(publicKey: string): Uint8Array<ArrayBuffer> {
  const padded = publicKey
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(publicKey.length / 4) * 4, '=')
  const raw = atob(padded)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

const jsonOf = (subscription: PushSubscriptionLike): PushSubscriptionJson =>
  'toJSON' in subscription && typeof subscription.toJSON === 'function'
    ? (subscription.toJSON() as PushSubscriptionJson)
    : (subscription as PushSubscriptionJson)

/** Registers this browser's subscription with the core under a label; the core replaces a row of the same endpoint. */
export function subscribePush(
  client: RpcClient,
  subscription: PushSubscriptionLike,
  label: string,
  options: SubscribePushOptions = {},
): Promise<PushRecord> {
  const { endpoint, expirationTime, keys } = jsonOf(subscription)
  return client.rpc.presence.push.subscribe({
    subscription: {
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      ...(expirationTime === undefined ? {} : { expirationTime }),
    },
    label: label.slice(0, 60),
    ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
    ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent.slice(0, 300) }),
  })
}

/** Removes one of the caller's subscriptions by its id or its endpoint; removing one that is not there is not an error. */
export async function unsubscribePush(
  client: RpcClient,
  target: { id: string } | { endpoint: string },
): Promise<void> {
  await client.rpc.presence.push.unsubscribe(target)
}

/** The caller's subscriptions (never the endpoint or the keys). */
export function listPush(client: RpcClient): Promise<PushRecord[]> {
  return client.rpc.presence.push.list()
}

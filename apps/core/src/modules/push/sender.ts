// The Web Push sender: one POST per subscription, no `web-push` dependency (ADR-0006). docs/specs/push.md, "Sending".
import { b64urlDecode } from './encoding.ts'
import { encryptPayload } from './encrypt.ts'
import { type VapidKeys, vapidAuthorization } from './vapid.ts'

export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

export type PushUrgency = 'normal' | 'high'

/**
 * What one send ended as. `gone`: the push service says the subscription no longer exists (404 or 410): delete it.
 * Any other failure is `gone: false` and counts against the subscription.
 */
export type PushSendResult =
  | { ok: true; status: number }
  | { ok: false; gone: boolean; status: number | null }

export interface PushSender {
  send(
    target: PushTarget,
    payload: string,
    options: { urgency: PushUrgency; ttlSeconds?: number },
  ): Promise<PushSendResult>
}

export interface PushSenderOptions {
  keys: VapidKeys
  fetch?: typeof fetch
  now?: () => number
  /** Per request wait (default 10 s). */
  timeoutMs?: number
}

/** How long a push service keeps a message for a device that is off (default 1 hour: older news is stale). */
export const DEFAULT_TTL_SECONDS = 3600

export function createPushSender(options: PushSenderOptions): PushSender {
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  return {
    async send(target, payload, { urgency, ttlSeconds }) {
      let status: number | null = null
      try {
        const body = await encryptPayload(payload, {
          p256dh: b64urlDecode(target.p256dh),
          auth: b64urlDecode(target.auth),
        })
        const response = await doFetch(target.endpoint, {
          method: 'POST',
          headers: {
            Authorization: await vapidAuthorization(options.keys, target.endpoint, now()),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: String(ttlSeconds ?? DEFAULT_TTL_SECONDS),
            Urgency: urgency === 'high' ? 'high' : 'normal',
          },
          body: body,
          // a push service does not redirect; one that does is a failure, not a hop to follow
          redirect: 'manual',
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        })
        status = response.status
        // the body is never read: it holds nothing we use
        void response.body?.cancel().catch(() => undefined)
        if (status >= 200 && status < 300) return { ok: true, status }
        return { ok: false, gone: status === 404 || status === 410, status }
      } catch {
        return { ok: false, gone: false, status }
      }
    },
  }
}

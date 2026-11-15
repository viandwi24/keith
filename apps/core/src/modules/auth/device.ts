import { timingSafeEqual } from 'node:crypto'
import {
  DevicePollRequestSchema,
  type DevicePollResponse,
  DeviceStartRequestSchema,
  type DeviceStartResponse,
} from '@keith/contracts'
import type { AuditVia, CredentialsRepo, DeviceRequestsRepo } from '@keith/db'
import {
  generatePairingCode,
  hashPairingCode,
  normalizePairingCode,
  PAIRING_ALPHABET,
  pairingGuard,
} from 'eharness/identity'
import type { Audit } from '../audit/index.ts'
import { formatCredential, hashSecret, newCredentialId, newSecret } from './credentials.ts'
import { json, readJson, refuse } from './http.ts'
import { createCookieIssuer, withSetCookie } from './web-session.ts'

/** A device code lives this long. */
export const DEVICE_TTL_MS = 600_000

export class DeviceError extends Error {
  constructor(
    readonly kind: 'not-found',
    message: string,
  ) {
    super(message)
  }
}

export interface DeviceLoginOptions {
  devices: DeviceRequestsRepo
  credentials: CredentialsRepo
  audit: Audit
  ttlMs?: number
  /** `start` calls allowed per client address inside `windowMs` (default 15 per 10 minutes). */
  maxStarts?: number
  /** Failed polls allowed per client address inside `windowMs` (default 20). */
  maxPollFailures?: number
  windowMs?: number
  now?: () => number
}

export interface DeviceLogin {
  /** `POST /auth/device/start`. `clientKey` is the socket address, never a forwarded header. */
  start(request: Request, clientKey: string, via: AuditVia): Promise<Response>
  /** `POST /auth/device/poll`. */
  poll(request: Request, clientKey: string, via: AuditVia): Promise<Response>
  /** Owner: approve the pending request with this code; the device receives a credential. */
  approve(input: {
    code: string
    label?: string | undefined
    personId: string
    via: AuditVia
  }): Promise<{ credentialId: string; label: string }>
  /**
   * Drop requests expired for more than an hour and revoke the credential of an approved one that
   * was never collected (`credential.revoked`, `by: 'expiry'`). Runs on each start and on the prune tick.
   */
  purge(): void
  /** Owner: refuse the pending request with this code. */
  deny(input: { code: string; actor: string; via: AuditVia }): Promise<void>
}

/** `ABCD-EFGH`. */
const formatCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`
const wellFormed = (code: string): boolean =>
  code.length === 8 && [...code].every((c) => PAIRING_ALPHABET.includes(c))

const sha256Hex = hashSecret

/** The credential secret derives from the poll secret, so core stores neither in clear. */
export async function deriveDeviceSecret(pollSecret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`keith-device-credential-v1:${pollSecret}`),
  )
  return Buffer.from(digest).toString('base64url')
}

const sameHex = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && timingSafeEqual(x, y)
}

const UNKNOWN = (): Response => refuse(404, 'NOT_FOUND', 'unknown, finished or expired request')

export function createDeviceLogin(options: DeviceLoginOptions): DeviceLogin {
  const now = options.now ?? Date.now
  const windowMs = options.windowMs ?? 600_000
  const startGuard = pairingGuard({ maxFailures: options.maxStarts ?? 15, windowMs })
  const pollGuard = pairingGuard({ maxFailures: options.maxPollFailures ?? 20, windowMs })
  const { devices, credentials, audit } = options
  const cookies = createCookieIssuer(credentials, now)

  /** The pending, unexpired request a code names (with the hash of its future secret). */
  const findPending = async (code: string) => {
    const normalized = normalizePairingCode(code)
    const found = wellFormed(normalized)
      ? devices.findPendingByCode(await hashPairingCode(normalized))
      : undefined
    const lookup = found === undefined ? undefined : devices.get(found.id)
    if (lookup === undefined)
      throw new DeviceError('not-found', 'no waiting login request has that code')
    return lookup
  }

  const purge = (): void => {
    const { credentialIds } = devices.purgeExpired(3_600_000)
    for (const credentialId of credentialIds) {
      const subject = credentials.find(credentialId)?.personId
      if (!credentials.revoke(credentialId, undefined, 'expiry')) continue
      audit.record({
        kind: 'credential.revoked',
        actor: 'system',
        via: 'local',
        detail: {
          credentialId,
          credentialKind: 'device',
          by: 'expiry',
          ...(subject ? { subject } : {}),
        },
      })
    }
  }

  return {
    purge,
    async start(request, clientKey, via) {
      if (!startGuard.allowed(clientKey, now())) {
        return refuse(429, 'TOO_MANY_ATTEMPTS', 'too many login requests: try again later')
      }
      const read = await readJson(request)
      if (!read.ok) return read.response
      const parsed = DeviceStartRequestSchema.safeParse(read.body)
      if (!parsed.success) return refuse(400, 'BAD_REQUEST', 'invalid login request')
      startGuard.failure(clientKey, now()) // every start counts toward the window
      purge()
      const code = normalizePairingCode(generatePairingCode())
      const pollSecret = newSecret()
      const id = newCredentialId() + newCredentialId()
      const label = parsed.data.label ?? 'device'
      const created = devices.create({
        id,
        codeHash: await hashPairingCode(code),
        pollHash: await sha256Hex(pollSecret),
        label,
        ip: clientKey,
        secretHash: await sha256Hex(await deriveDeviceSecret(pollSecret)),
        ttlMs: options.ttlMs ?? DEVICE_TTL_MS,
      })
      if (!created.ok || created.expiresAt === undefined) {
        return refuse(429, 'TOO_MANY_PENDING', 'too many login requests are waiting: try later')
      }
      audit.record({
        kind: 'device.requested',
        actor: 'system',
        via,
        detail: { requestId: id, ip: clientKey, label },
      })
      const reply: DeviceStartResponse = {
        code: formatCode(code),
        requestId: id,
        expiresAt: created.expiresAt,
        pollSecret,
      }
      return json(200, reply)
    },

    async poll(request, clientKey, via) {
      if (!pollGuard.allowed(clientKey, now())) {
        return refuse(429, 'TOO_MANY_ATTEMPTS', 'too many failed attempts: try again later')
      }
      const read = await readJson(request)
      if (!read.ok) return read.response
      const parsed = DevicePollRequestSchema.safeParse(read.body)
      if (!parsed.success) return refuse(400, 'BAD_REQUEST', 'invalid poll request')
      const { requestId, pollSecret } = parsed.data
      const found = devices.get(requestId)
      const given = await sha256Hex(pollSecret)
      // same work whether or not the id exists
      if (found === undefined || !sameHex(found.pollHash, given)) {
        pollGuard.failure(clientKey, now())
        return UNKNOWN()
      }
      const reply = (body: DevicePollResponse): Response => json(200, body)
      if (found.expiresAt <= now()) {
        devices.remove(found.id)
        // approved but never collected: the credential was never handed over, so it dies too
        if (found.credentialId !== null) credentials.revoke(found.credentialId)
        audit.record({
          kind: 'device.expired',
          actor: 'system',
          via,
          detail: { requestId: found.id, ip: found.ip, label: found.label },
        })
        return reply({ status: 'expired' })
      }
      if (found.status === 'pending') return reply({ status: 'pending' })
      devices.remove(found.id) // single use: whatever the answer, the request is consumed now
      if (found.status === 'denied' || found.credentialId === null)
        return reply({ status: 'denied' })
      const credential = formatCredential(found.credentialId, await deriveDeviceSecret(pollSecret))
      if (parsed.data.deliver === 'cookie') {
        // the credential never reaches the page: it goes into the HttpOnly cookie (a browser-session cookie)
        return withSetCookie(
          reply({ status: 'approved', cookie: true }),
          cookies.issue(request, credential, false),
        )
      }
      return reply({ status: 'approved', credential })
    },

    async approve({ code, label, personId, via }) {
      const request = await findPending(code)
      const credentialId = newCredentialId()
      const finalLabel = label ?? request.label
      credentials.create({
        id: credentialId,
        personId,
        kind: 'device',
        label: finalLabel,
        secretHash: request.secretHash,
      })
      if (!devices.approve(request.id, credentialId)) {
        credentials.revoke(credentialId)
        throw new DeviceError('not-found', 'that login request is no longer waiting')
      }
      audit.record({
        kind: 'device.approved',
        actor: personId,
        via,
        detail: { requestId: request.id, credentialId, label: finalLabel, ip: request.ip },
      })
      audit.record({
        kind: 'credential.created',
        actor: personId,
        via,
        detail: { credentialId, credentialKind: 'device', subject: personId, label: finalLabel },
      })
      return { credentialId, label: finalLabel }
    },

    async deny({ code, actor, via }) {
      const request = await findPending(code)
      if (!devices.deny(request.id)) {
        throw new DeviceError('not-found', 'that login request is no longer waiting')
      }
      audit.record({
        kind: 'device.denied',
        actor,
        via,
        detail: { requestId: request.id, ip: request.ip, label: request.label },
      })
    },
  }
}

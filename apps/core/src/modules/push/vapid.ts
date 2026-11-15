// VAPID (RFC 8292): the application server key pair and the ES256 JWT of each push request. docs/specs/push.md, "VAPID".
import { b64urlEncode } from './encoding.ts'

/** The JWT lifetime: under the 24 h a push service allows and under the 12 h the spec of the core keeps. */
export const JWT_TTL_SECONDS = 11 * 3600

/** The key pair as the sender uses it: the public point in base64url and the signing key. */
export interface VapidKeys {
  /** An uncompressed P-256 point, base64url: the `applicationServerKey` and the `k=` of the header. */
  publicKey: string
  privateKey: CryptoKey
  /** `mailto:` or https URL: who runs this server. */
  subject: string
}

/** A new ECDSA P-256 pair: the public key and the private key as a JWK string (to be sealed by the caller). */
export async function generateVapidPair(): Promise<{ publicKey: string; privateJwk: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const publicKey = b64urlEncode(
    new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
  )
  const privateJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey))
  return { publicKey, privateJwk }
}

/** The signing key of a stored JWK (not extractable once loaded). */
export function importVapidPrivate(privateJwk: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    JSON.parse(privateJwk),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
}

const enc = new TextEncoder()
const part = (value: unknown): string => b64urlEncode(enc.encode(JSON.stringify(value)))

/** The ES256 JWT of one request: `aud` is the origin of the endpoint, `exp` at most `JWT_TTL_SECONDS` ahead. */
export async function vapidJwt(keys: VapidKeys, endpoint: string, nowMs: number): Promise<string> {
  const aud = new URL(endpoint).origin
  const signingInput = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud,
    exp: Math.floor(nowMs / 1000) + JWT_TTL_SECONDS,
    sub: keys.subject,
  })}`
  // WebCrypto's ECDSA signature is r||s (IEEE P1363), the form JWS ES256 wants
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.privateKey,
      enc.encode(signingInput),
    ),
  )
  return `${signingInput}.${b64urlEncode(signature)}`
}

/** The `Authorization` value: `vapid t=<jwt>, k=<public key>`. */
export async function vapidAuthorization(
  keys: VapidKeys,
  endpoint: string,
  nowMs: number,
): Promise<string> {
  return `vapid t=${await vapidJwt(keys, endpoint, nowMs)}, k=${keys.publicKey}`
}

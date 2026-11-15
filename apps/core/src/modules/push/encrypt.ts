// RFC 8291 message encryption for Web Push, content coding `aes128gcm` (RFC 8188), with WebCrypto only:
// ECDH P-256 + HKDF-SHA-256 + AES-128-GCM, one record. docs/specs/push.md, "Encryption".
import { type Bytes, b64urlEncode, concat } from './encoding.ts'

/** The record size written in the header: one record of at most this many bytes. */
export const RECORD_SIZE = 4096
/** Most payload bytes one record holds: the record size less the 16-byte tag and the 1-byte delimiter. */
export const MAX_PLAINTEXT = RECORD_SIZE - 16 - 1

const enc = new TextEncoder()

export interface EncryptOptions {
  /** The subscription's `keys.p256dh`: 65 bytes, an uncompressed P-256 point. */
  p256dh: Bytes
  /** The subscription's `keys.auth`: 16 bytes. */
  auth: Bytes
  /** Test seam: the salt (16 random bytes by default). */
  salt?: Bytes
  /** Test seam: the application server's ephemeral key pair (a new one by default). */
  serverKeys?: { publicRaw: Bytes; privateKey: CryptoKey }
}

async function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt, info: info },
    key,
    bytes * 8,
  )
  return new Uint8Array(bits)
}

/** A P-256 private key from its base64url scalar and the public point (used by tests and the RFC vector). */
export async function importP256Private(
  d: Bytes,
  publicRaw: Bytes,
  usage: 'deriveBits' | 'sign',
): Promise<CryptoKey> {
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: b64urlEncode(d),
    x: b64urlEncode(publicRaw.slice(1, 33)),
    y: b64urlEncode(publicRaw.slice(33, 65)),
  }
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    usage === 'sign'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [usage],
  )
}

/**
 * Encrypts one message for a subscription. The result is the whole request body: header (salt, record size, key id = the
 * server's ephemeral public key) followed by the single encrypted record.
 */
export async function encryptPayload(
  payload: Bytes | string,
  options: EncryptOptions,
): Promise<Bytes> {
  const data = typeof payload === 'string' ? enc.encode(payload) : payload
  if (data.length > MAX_PLAINTEXT) throw new Error(`push payload over ${MAX_PLAINTEXT} bytes`)
  if (options.p256dh.length !== 65 || options.p256dh[0] !== 0x04)
    throw new Error('p256dh is not an uncompressed P-256 point')
  if (options.auth.length !== 16) throw new Error('auth secret is not 16 bytes')

  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16))
  let serverKeys = options.serverKeys
  if (serverKeys === undefined) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])
    serverKeys = {
      publicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
      privateKey: pair.privateKey,
    }
  }
  const uaPublic = await crypto.subtle.importKey(
    'raw',
    options.p256dh,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublic }, serverKeys.privateKey, 256),
  )

  // RFC 8291 §3.4: IKM = HKDF(auth, ecdh, "WebPush: info" 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(enc.encode('WebPush: info\0'), options.p256dh, serverKeys.publicRaw)
  const ikm = await hkdf(ecdh, options.auth, keyInfo, 32)
  // RFC 8188 §2.2, §2.3: CEK (16) and NONCE (12) from the salt
  const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12)

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // the last (here the only) record ends with the delimiter 0x02
  const record = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      concat(data, new Uint8Array([0x02])),
    ),
  )

  const header = new Uint8Array(16 + 4 + 1 + serverKeys.publicRaw.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false)
  header[20] = serverKeys.publicRaw.length
  header.set(serverKeys.publicRaw, 21)
  return concat(header, record)
}

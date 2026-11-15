// base64url without padding and byte helpers shared by the Web Push code (docs/specs/push.md).

/** A byte array over a plain ArrayBuffer: what WebCrypto accepts. */
export type Bytes = Uint8Array<ArrayBuffer>

export function b64urlEncode(bytes: Bytes): string {
  return Buffer.from(bytes).toString('base64url')
}

/** Decodes base64url (padding tolerated). Throws on any character outside the alphabet. */
export function b64urlDecode(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new Error('not base64url')
  return new Uint8Array(Buffer.from(text, 'base64url'))
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

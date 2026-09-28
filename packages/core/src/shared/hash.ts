// The one hash for secrets stored at rest (auth tokens and invite codes): `keith person` writes
// invite code hashes and the server looks them up, so both must use this function.

/** SHA-256 of the string's UTF-8 bytes, lowercase hex. */
export function sha256Hex(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex')
}

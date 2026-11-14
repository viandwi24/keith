import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type SecretVault, webCryptoVault } from 'eharness/providers'

/** 32 random bytes, base64. */
export function generateSecretKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
}

export function parseSecretKey(text: string): Uint8Array {
  const bytes = Buffer.from(text.trim(), 'base64')
  if (bytes.byteLength !== 32) throw new Error('KEITH_SECRET_KEY must be 32 bytes, base64')
  return new Uint8Array(bytes)
}

/**
 * The vault that seals stored credentials (ADR-0007). The key comes from `KEITH_SECRET_KEY`;
 * without it a dev key is created once in `<dataDir>/secret.key` (mode 0600) and `devKey` is
 * true so the caller can warn. Losing the key makes stored credentials unreadable.
 *
 * `create: false` (doctor, P23.4.6) never writes the file: with no key to read, the vault holds a random key
 * that opens nothing stored, so every stored secret reads as "cannot be opened by this process".
 */
export function createVault(
  secretKey: string | undefined,
  dataDir: string,
  options: { create?: boolean } = {},
): { vault: SecretVault; devKey: boolean } {
  if (secretKey !== undefined)
    return { vault: webCryptoVault(parseSecretKey(secretKey)), devKey: false }
  const file = resolve(dataDir, 'secret.key')
  if (!existsSync(file) && options.create === false)
    return { vault: webCryptoVault(parseSecretKey(generateSecretKey())), devKey: false }
  if (!existsSync(file)) {
    writeFileSync(file, `${generateSecretKey()}\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
  }
  return { vault: webCryptoVault(parseSecretKey(readFileSync(file, 'utf8'))), devKey: true }
}

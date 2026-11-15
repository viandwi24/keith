// The VAPID key pair of this core: generated once with WebCrypto, the private key sealed in the vault (ADR-0007) and kept in
// the `settings` table under `push.vapid`. docs/specs/push.md, "VAPID".
import type { SecretVault } from 'eharness/providers'
import { generateVapidPair, importVapidPrivate, type VapidKeys } from './vapid.ts'

/** The settings key of the sealed pair. */
export const VAPID_SETTING = 'push.vapid'
const VAULT_CONTEXT = 'push.vapid'

interface StoredVapid {
  publicKey: string
  /** The private key as a JWK string, sealed by the vault. */
  sealed: string
}

export interface VapidStoreDeps {
  settings: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }
  vault: Pick<SecretVault, 'seal' | 'open'>
  subject: string
  warn?: (message: string) => void
}

/**
 * The stored pair, or a new one when none is stored. A pair this process cannot open (the secret key changed) is replaced:
 * the subscriptions made with the old public key then fail and are dropped by the sender, and the browsers subscribe again.
 */
export async function loadVapidKeys(deps: VapidStoreDeps): Promise<VapidKeys> {
  const stored = deps.settings.get<StoredVapid>(VAPID_SETTING)
  if (stored !== undefined) {
    try {
      const privateKey = await importVapidPrivate(
        await deps.vault.open(stored.sealed, VAULT_CONTEXT),
      )
      return { publicKey: stored.publicKey, privateKey, subject: deps.subject }
    } catch {
      deps.warn?.('push: the stored VAPID key cannot be opened; a new pair replaces it')
    }
  }
  const pair = await generateVapidPair()
  const sealed = await deps.vault.seal(pair.privateJwk, VAULT_CONTEXT)
  deps.settings.set(VAPID_SETTING, { publicKey: pair.publicKey, sealed } satisfies StoredVapid)
  return {
    publicKey: pair.publicKey,
    privateKey: await importVapidPrivate(pair.privateJwk),
    subject: deps.subject,
  }
}

/** The VAPID subject: `KEITH_PUSH_SUBJECT`, else the public URL when it is https, else a placeholder mailto. */
export function pushSubject(config: {
  pushSubject?: string | undefined
  publicUrl?: string | undefined
}): string {
  if (config.pushSubject !== undefined) return config.pushSubject
  if (config.publicUrl?.startsWith('https://')) return config.publicUrl
  return 'mailto:keith@localhost.invalid'
}

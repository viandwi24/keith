// The Web Push wiring (docs/specs/push.md): the VAPID pair (private key sealed in the vault), the sender, the subscriptions
// repo and the removal part. compose.ts builds it once; the delivery planner and the `presence.push` procedures use it.
import { pushSubscriptionsRepo, type settingsRepo } from '@keith/db'
import type { SecretVault } from 'eharness/providers'
import type { createIdentity } from './compose-identity.ts'
import {
  createPushSender,
  createPushService,
  loadVapidKeys,
  type PushService,
  pushRemoval,
  pushSubject,
} from './modules/push/index.ts'
import type { Config } from './platform/config.ts'
import type { Logger } from './platform/logger.ts'

type Identity = ReturnType<typeof createIdentity>

export interface PushWiring {
  sqlite: Parameters<typeof pushSubscriptionsRepo>[0]
  settings: ReturnType<typeof settingsRepo>
  vault: SecretVault
  config: Pick<Config, 'pushSubject' | 'publicUrl'>
  audit: Identity['audit']
  removal: Identity['removal']
  logger: Logger
  /** Test seam: the HTTP client of the sender. */
  fetch?: typeof fetch
}

export async function createPush(w: PushWiring): Promise<PushService> {
  const keys = await loadVapidKeys({
    settings: w.settings,
    vault: w.vault,
    subject: pushSubject(w.config),
    warn: (message) => w.logger.warn(message),
  })
  const service = createPushService({
    repo: pushSubscriptionsRepo(w.sqlite),
    settings: w.settings,
    sender: createPushSender({ keys, ...(w.fetch === undefined ? {} : { fetch: w.fetch }) }),
    publicKey: keys.publicKey,
    audit: w.audit,
    warn: (message) => w.logger.warn(message),
  })
  w.removal.registry.registerRemoval({ module: 'push', onPersonRemoved: pushRemoval(service) })
  return service
}

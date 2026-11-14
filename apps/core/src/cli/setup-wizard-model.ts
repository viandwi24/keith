// State and loading of the setup wizard (no drawing).
import type { AccessMode } from '@keith/contracts'
import type { OfflineAdmin } from '../modules/admin/index.ts'
import type { Config } from '../platform/config.ts'
import {
  budgetDefault,
  currentNetwork,
  currentOwnerName,
  ownerSignInKinds,
  safeUser,
} from './setup-steps.ts'

export type StepId =
  | 'name'
  | 'provider'
  | 'connect'
  | 'front'
  | 'cortex'
  | 'budget'
  | 'access'
  | 'url'
  | 'pin'
  | 'pin2'
  | 'summary'

export const TITLE: Record<StepId, string> = {
  name: 'Your name',
  provider: 'AI provider',
  connect: 'Connection',
  front: 'Front model',
  cortex: 'Cortex model',
  budget: 'Budget',
  access: 'Access',
  url: 'Public URL',
  pin: 'Owner sign-in',
  pin2: 'Confirm PIN',
  summary: 'Summary',
}

/** Non-secret answers; secrets (API key, PIN) live in refs and never reach a rendered value. */
export interface Draft {
  name: string
  provider: string
  reuse: boolean
  untested: boolean
  front: string
  cortex: string
  budget: string
  mode: AccessMode
  publicUrl: string
  hasPin: boolean
}

export interface Loaded {
  described: Array<{ id: string; label: string; hasKeyField: boolean }>
  connections: Array<{ id: string; providerId: string; enabled: boolean; source?: string }>
  /** The owner already signs in with these (`pin`, `password`): the PIN step may keep them. */
  ownerSignIn: string[]
  draft: Draft
}

export async function load(admin: OfflineAdmin, config: Config): Promise<Loaded> {
  const [described, connections] = await Promise.all([
    admin.providers.describe(),
    admin.providers.list(),
  ])
  const net = currentNetwork(config, admin)
  const current = connections.find((c) => c.enabled)
  return {
    described: described.map((d) => ({
      id: d.id,
      label: d.label,
      hasKeyField: d.fields.some((f) => f.path === 'apiKey' && f.secret),
    })),
    connections,
    ownerSignIn: ownerSignInKinds(admin),
    draft: {
      name: currentOwnerName(admin) ?? safeUser(),
      provider: current?.providerId ?? 'openrouter',
      reuse: false,
      untested: false,
      front: '',
      cortex: '',
      budget: budgetDefault(admin),
      mode: net.mode,
      publicUrl: net.publicUrl ?? '',
      hasPin: false,
    },
  }
}

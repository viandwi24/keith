import type { Health, ModelRoles, Whoami } from '@keith/contracts'
import { G } from '@keith/ui'
import { remaining } from '../stepup/index.ts'

export interface WhoamiInfo {
  me: Whoami
  /** The core as the TUI knows it: a URL or `unix:<path>`. */
  core: string
  health: Health | undefined
  roles: ModelRoles | undefined
  /** When this session's step-up ends (epoch ms), if this run stepped up. */
  elevatedUntil?: number | undefined
  now?: number
}

/**
 * `/whoami`: the rows of an info notice in the conversation: name, role and login name, how this
 * client reached the core and with which credential, whether it is stepped up, the core's version
 * and the front model.
 */
export function whoamiRows({
  me,
  core,
  health,
  roles,
  elevatedUntil,
  now = Date.now(),
}: WhoamiInfo): string[] {
  // a session made by a PIN or a password says so (`device credential (pin session)`)
  const implicit = me.via === 'local' && me.credentialKind === null
  const made = me.methods?.find((m) => m === 'pin' || m === 'password')
  const credential = `${me.credentialKind ?? 'unknown'} credential${made === undefined ? '' : ` (${made} session)`}`
  const via = implicit ? 'local socket' : credential
  const version = health === undefined ? 'not connected' : `${health.version} (${health.sha})`
  const left = elevatedUntil === undefined ? 0 : elevatedUntil - now
  const elevated = implicit
    ? 'yes (local socket)'
    : left > 0
      ? `yes (${remaining(left)} left)`
      : me.elevated
        ? 'yes'
        : 'no (needed for sensitive actions: /stepup)'
  return [
    `${me.name}  ${me.role}  ${G.sep} login ${me.username ?? 'none'}`,
    `via   ${via}  ${core}`,
    `elevated  ${elevated}`,
    `core  ${version} ${G.sep} front ${roles?.front ?? 'no model'}`,
  ]
}

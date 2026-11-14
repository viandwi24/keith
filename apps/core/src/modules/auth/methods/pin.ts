import { createSecretLogin, type SecretLoginOptions } from './secret-login.ts'
import type { AuthMethod } from './types.ts'

export const DEFAULT_PIN_LABEL = 'pin login'

/**
 * The PIN (6 to 12 digits): starts a session of assurance 1 from `loopback`, `lan` and `tailscale`,
 * never from `public`. A PIN session cannot step up (docs/specs/auth.md). Its strength comes from
 * the zone, the throttle (shared with the password: one subject per person) and argon2id, not from
 * entropy; on the LAN a person-wide delay follows the failures and an audit alert is written.
 */
export function createPinMethod(options: SecretLoginOptions): AuthMethod {
  return {
    id: 'pin',
    label: 'PIN',
    assurance: 1,
    interaction: 'form',
    firstStep: {
      id: 'pin',
      title: 'PIN',
      fields: [{ name: 'pin', label: 'PIN', kind: 'digits', mask: true, length: 12 }],
    },
    neverPublic: true,
    refusal: 'not accepted from this network: use the password or the device code',
    verifyFor: createSecretLogin(
      {
        kind: 'pin',
        method: 'pin',
        assurance: 1,
        defaultLabel: DEFAULT_PIN_LABEL,
        personWideDelay: true,
      },
      options,
    ),
  }
}

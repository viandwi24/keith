import type { AuthMethod } from './types.ts'

/**
 * A pasted credential from `keith-core token create`. There is no server step: the client checks
 * it with `auth.whoami`. Listed so every method is data and policy can restrict it.
 */
export const tokenMethod: AuthMethod = {
  id: 'token',
  label: 'Token',
  assurance: 0,
  interaction: 'form',
  firstStep: {
    id: 'token',
    title: 'Token',
    fields: [{ name: 'token', label: 'Credential', kind: 'secret', mask: true }],
  },
  refusal: 'not accepted from this network: use a private network address or the device code',
}

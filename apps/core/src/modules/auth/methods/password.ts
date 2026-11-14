import type { CredentialsRepo, SecretsRepo } from '@keith/db'
import type { Audit } from '../../audit/index.ts'
import type { Hasher } from '../hasher.ts'
import type { Throttle } from '../throttle.ts'
import {
  createSecretLogin,
  MAX_SESSIONS_PER_PERSON,
  type SecretAttempt,
  type SecretOutcome,
} from './secret-login.ts'
import type { AuthMethod } from './types.ts'

export const DEFAULT_LOGIN_LABEL = 'password login'
export { MAX_SESSIONS_PER_PERSON }

export interface PasswordAttempt extends Omit<SecretAttempt, 'secret'> {
  username: string
  password: string
  /** False when policy (role, identifier kind) refuses here: the same work, then the uniform 401. */
  permitted: boolean
}

export type PasswordOutcome = SecretOutcome

export interface PasswordMethod extends AuthMethod {
  /**
   * Verify a username and password: the throttle, the dummy hash for an unknown user, the audit
   * rows and the credential of a success. Every refusal is the same 401 (docs/specs/auth.md).
   */
  verify(attempt: PasswordAttempt): Promise<PasswordOutcome>
  /** The same check for a person the caller already resolved (login and flow). */
  verifyFor: NonNullable<AuthMethod['verifyFor']>
}

export interface PasswordMethodOptions {
  secrets: SecretsRepo
  credentials: CredentialsRepo
  hasher: Hasher
  throttle: Throttle
  audit: Audit
}

export function createPasswordMethod(options: PasswordMethodOptions): PasswordMethod {
  const verifyFor = createSecretLogin(
    {
      kind: 'password',
      method: 'password',
      assurance: 2,
      defaultLabel: DEFAULT_LOGIN_LABEL,
      personWideDelay: false,
    },
    options,
  )
  return {
    id: 'password',
    label: 'Password',
    assurance: 2,
    interaction: 'form',
    firstStep: {
      id: 'password',
      title: 'Password',
      fields: [
        { name: 'username', label: 'Username', kind: 'text' },
        { name: 'password', label: 'Password', kind: 'secret', mask: true },
      ],
    },
    /** The flow already knows who is signing in, so it asks for the password only. */
    flowStep: {
      id: 'password',
      title: 'Password',
      fields: [{ name: 'password', label: 'Password', kind: 'secret', mask: true }],
    },
    refusal: 'not accepted from this network: use a private network address or the device code',

    async verify({ username, password, permitted, ...rest }) {
      const seed = username.trim().toLowerCase()
      return verifyFor({
        ...rest,
        secret: password,
        person: options.secrets.findPerson(seed),
        seed,
        permitted,
      })
    },

    verifyFor,
  }
}

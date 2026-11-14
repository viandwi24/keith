import type { Assurance, Step } from '@keith/contracts'
import type { FlowSecretAttempt, SecretOutcome } from './secret-login.ts'

/**
 * A sign-in method (ADR-0014, docs/specs/auth.md). An adapter is one file in this folder that
 * describes itself as data; the registry lists it, the policy says where it is allowed. Adapters
 * with a server-side verify (the password today) extend this with their own `verify`.
 */
export interface AuthMethod {
  /** Registry key and policy `method`; also the `id` of `GET /auth/methods` for the legacy three. */
  readonly id: string
  readonly label: string
  readonly assurance: Assurance
  /** `form`: the user types the answer; `poll`: the client polls (device code). */
  readonly interaction: 'form' | 'poll'
  readonly firstStep: Step
  /** The step the identifier-first flow shows when the identity is already known (default `firstStep`). */
  readonly flowStep?: Step
  /** Never offered or accepted from the `public` zone, even when `KEITH_INSECURE_LOGIN` lifts the rest (a PIN). */
  readonly neverPublic?: boolean
  /** The server step of a method the flow can verify (the password, the PIN): the identity is already resolved. */
  readonly verifyFor?: (attempt: FlowSecretAttempt) => Promise<SecretOutcome>
  /** Generic hint shown when the policy refuses the method here: no address, no setting. */
  readonly refusal: string
}

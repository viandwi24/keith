import { logout } from '@keith/client/browser'
import type { Whoami } from '@keith/contracts'
import { getClient } from './client.ts'
import { type SessionStatus, statusOfFailure } from './gate.ts'

/** Who the core says this browser is (`auth.whoami`), read on load and after a sign-in. */
class Session {
  status = $state<SessionStatus>('loading')
  me = $state<Whoami | undefined>(undefined)
  error = $state<string | undefined>(undefined)

  async load(): Promise<void> {
    try {
      this.me = await getClient().rpc.auth.whoami()
      this.error = undefined
      this.status = 'signed-in'
    } catch (error) {
      const status = statusOfFailure(error)
      if (status === 'signed-out') this.me = undefined
      // a blip keeps a known person: only a refused credential signs out
      if (status === 'error' && this.me !== undefined) return
      this.error =
        status === 'error' ? ((error as Error).message ?? 'the core did not answer') : undefined
      this.status = status
    }
  }

  /** The feed said the core refused the credential. */
  expire(): void {
    this.me = undefined
    this.status = 'signed-out'
  }

  async signOut(): Promise<void> {
    try {
      await logout()
    } catch {
      // the cookie may be gone already; the page leaves the session either way
    }
    this.expire()
  }
}

export const session = new Session()

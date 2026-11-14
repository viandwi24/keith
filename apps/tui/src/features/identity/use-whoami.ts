import { isLockedError, type KeithClient } from '@keith/client'
import type { Whoami } from '@keith/contracts'
import { useCallback, useEffect, useState } from 'react'
import { isUnauthorized } from '../../unauthorized.ts'

export type Identity =
  | { status: 'loading' }
  | { status: 'ready'; me: Whoami }
  /** The core refused the credential (401): logged out or revoked. */
  | { status: 'logged-out' }
  /** The local socket is locked (423): the owner's PIN opens it. */
  | { status: 'locked' }
  | { status: 'error'; message: string }

/** Who the core says this client is (`auth.whoami`): read at mount and on `reload()`. */
export function useWhoami(client: KeithClient): { identity: Identity; reload(): void } {
  const [identity, setIdentity] = useState<Identity>({ status: 'loading' })
  const reload = useCallback(() => {
    client.rpc.auth
      .whoami()
      .then((me) => setIdentity({ status: 'ready', me }))
      .catch((error: Error) =>
        setIdentity((prev) =>
          isUnauthorized(error)
            ? { status: 'logged-out' }
            : isLockedError(error)
              ? { status: 'locked' }
              : // keep a known person through a blip: the chat session depends on it
                prev.status === 'ready'
                ? prev
                : { status: 'error', message: error.message },
        ),
      )
  }, [client])
  useEffect(reload, [reload])
  return { identity, reload }
}

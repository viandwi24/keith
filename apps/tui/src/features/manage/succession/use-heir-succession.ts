import type { KeithClient } from '@keith/client'
import type { SuccessionHeirView } from '@keith/contracts'
import { useCallback, useEffect, useState } from 'react'

/** How often the heir's view is read again while the app is open (a claim window lasts days). */
export const HEIR_POLL_MS = 60_000

/**
 * The heir's view of the succession (`admin.succession.get`), read at mount, every minute and on `reload()`.
 * Only the heir gets one: the owner, anyone else (`NOT_FOUND`) and a failed read give `undefined`, so Home shows
 * no succession caption to them.
 */
export function useHeirSuccession(
  client: KeithClient,
  enabled: boolean,
): { view: SuccessionHeirView | undefined; reload(): void } {
  const [view, setView] = useState<SuccessionHeirView | undefined>()
  const reload = useCallback(() => {
    client.rpc.admin.succession.get().then(
      (v) => setView(v.role === 'heir' ? v : undefined),
      () => setView(undefined),
    )
  }, [client])
  useEffect(() => {
    if (!enabled) {
      setView(undefined)
      return undefined
    }
    reload()
    const timer = setInterval(reload, HEIR_POLL_MS)
    return () => clearInterval(timer)
  }, [enabled, reload])
  return { view, reload }
}

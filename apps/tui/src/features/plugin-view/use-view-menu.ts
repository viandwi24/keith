import type { KeithClient } from '@keith/client'
import type { ViewMenu } from '@keith/contracts'
import { useEffect, useState } from 'react'

export interface ViewMenuState {
  items: ViewMenu['items']
}

const NONE: ViewMenu['items'] = []

/**
 * The plugin views this person may open (`GET /plugins/tui/menu`, already filtered by the core). Read when `ready` turns
 * true and again whenever `refreshKey` changes (the connection came back); a core that has no plugin routes, a refusal or
 * a dead core is an empty list, never an error on Home.
 */
export function useViewMenu(
  client: Pick<KeithClient, 'viewMenu'>,
  { ready, refreshKey }: { ready: boolean; refreshKey?: string | undefined },
): ViewMenuState {
  const [items, setItems] = useState<ViewMenu['items']>(NONE)
  useEffect(() => {
    void refreshKey
    if (!ready) {
      setItems(NONE)
      return undefined
    }
    let live = true
    client
      .viewMenu()
      .then((menu) => {
        if (live) setItems(menu.items)
      })
      .catch(() => {
        if (live) setItems(NONE)
      })
    return () => {
      live = false
    }
  }, [client, ready, refreshKey])
  return { items }
}

import { definePlugin, type HarnessPlugin } from 'eharness'
import { WEB_SEARCH_TOOL } from 'eharness/web'
import type { ProviderService } from '../providers/index.ts'
import { searchModel } from './web-search.ts'

/**
 * Plugin: offer `web_search` only while a connection can search. Connections are data and change
 * at runtime (`/connect`), so the check runs at every step instead of once at boot; the tool list
 * only changes when the answer changes, which keeps the prompt cache stable otherwise.
 */
export function searchGate(providers: ProviderService): HarnessPlugin<'keith-search-gate'> {
  return definePlugin({
    name: 'keith-search-gate',
    setup: () => ({
      hooks: {
        'step.prepare': async (_ctx, e) => {
          if (!e.toolNames.includes(WEB_SEARCH_TOOL)) return
          const available = await searchModel(providers).catch(() => undefined)
          if (available !== undefined) return
          return { activeTools: e.toolNames.filter((name) => name !== WEB_SEARCH_TOOL) }
        },
      },
    }),
  })
}

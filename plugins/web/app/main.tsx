/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { normalizeBaseUrl, webStorageSessionStore } from '@keith/client'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './components/app.tsx'

/**
 * Browser entry. The core serves this app (the `@keith/web` plugin), so the core is the page's
 * own origin; the session lives in `localStorage` (key `keith.session`).
 */
const root = document.getElementById('root')
if (!root) throw new Error('missing #root element')

const baseUrl = normalizeBaseUrl(window.location.origin)
const store = webStorageSessionStore(window.localStorage)

createRoot(root).render(
  <StrictMode>
    <App baseUrl={baseUrl} store={store} />
  </StrictMode>,
)

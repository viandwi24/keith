import adapter from '@sveltejs/adapter-static'
import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig, type ProxyOptions } from 'vite'

/** The core the dev server forwards to (docs/specs/web.md, "Development"). */
const CORE = 'http://127.0.0.1:7420'

/**
 * One forwarded prefix. The core's Host and Origin guard compares the two with its own address, so both are rewritten to the
 * target; the page and the cookie stay on the dev server's host, and the proxied answer sets the cookie for it.
 */
const toCore = (ws = false): ProxyOptions => ({
  target: CORE,
  changeOrigin: true,
  ws,
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq) => {
      if (proxyReq.getHeader('origin') !== undefined) proxyReq.setHeader('origin', CORE)
    })
    proxy.on('proxyReqWs', (proxyReq) => {
      if (proxyReq.getHeader('origin') !== undefined) proxyReq.setHeader('origin', CORE)
    })
  },
})

export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
      },
      // A single-page app: the core serves `200.html` for every route under /app.
      adapter: adapter({ fallback: '200.html' }),
      paths: { base: '/app' },
      // registered by the page (`features/pwa/register.ts`) on the owner's app only: the guest page has no worker
      serviceWorker: { register: false },
    }),
  ],
  server: {
    proxy: {
      '/health': toCore(),
      '/auth': toCore(),
      '/rpc': toCore(),
      '/sessions': toCore(),
      '/activity': toCore(),
      '/attention': toCore(),
      '/presence': toCore(),
      '/guest': toCore(),
      '/plugins': toCore(true),
    },
  },
})

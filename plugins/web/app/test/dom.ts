/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { afterAll, beforeAll } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

/**
 * A DOM for the web app's component tests (Bun's DOM testing guide: happy-dom's global registrator),
 * scoped to the files that ask for it instead of a repo-wide `preload`, because the root `bun test`
 * runs every package's tests in one process.
 *
 * Call `useDom()` at the top of a test file, then load Testing Library and the components with
 * `await import(...)`. Bun evaluates CommonJS dependencies such as `react-dom` before the importing
 * module's body runs, so a static import would load React DOM before the DOM exists (and React
 * decides at load time whether it runs in a browser). `useDom()` registers the DOM at once, again
 * before the file's tests if an earlier file removed it, and removes it after the file.
 *
 * Bun's own networking, timers and URL stay in place, so tests talk to the fake core over real
 * local sockets exactly as the browser would.
 */

const KEEP_NATIVE = [
  'fetch',
  'Request',
  'Response',
  'Headers',
  'FormData',
  'Blob',
  'File',
  'WebSocket',
  'URL',
  'URLSearchParams',
  'AbortController',
  'AbortSignal',
  'TextEncoder',
  'TextDecoder',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'structuredClone',
  'crypto',
  'performance',
] as const

export function registerDom(): void {
  if (GlobalRegistrator.isRegistered) return
  const saved = KEEP_NATIVE.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  GlobalRegistrator.register({
    url: 'http://localhost:4824/',
    settings: {
      // The `html` block's iframe must never load or run anything in tests.
      disableIframePageLoading: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  })
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
  }
}

export async function unregisterDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister()
}

/** Registers the DOM for the calling test file and removes it after the file's tests. */
export function useDom(): void {
  registerDom()
  beforeAll(registerDom)
  afterAll(unregisterDom)
}

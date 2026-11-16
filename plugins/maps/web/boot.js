// Runs before the engine (a classic script, first in map.html). The page lives in a sandboxed iframe with an opaque origin (ADR-0038
// §6), so a worker started from the core's own URL is refused as cross-origin; the engine thinks the core is its own origin and starts
// its workers that way. Every worker is started instead from a shim that imports the real file: `data:` for a module worker, `blob:`
// for a classic one (CSP `worker-src blob: data:`, ADR-0040). The engine finds its workers, assets and wasm under ./vendor/cesium/.

;(() => {
  const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window))
  w.CESIUM_BASE_URL = new URL('./vendor/cesium/', document.baseURI).href
  const Native = window.Worker
  /**
   * @param {string | URL} url
   * @param {WorkerOptions} [options]
   */
  function ShimWorker(url, options) {
    const href = String(url)
    if (href.startsWith('blob:') || href.startsWith('data:')) return new Native(href, options)
    const abs = new URL(href, document.baseURI).href
    // a module worker loads only from `data:` in an opaque-origin frame (never from `blob:null`); a classic one from `blob:`
    if (options?.type === 'module')
      return new Native(
        `data:text/javascript,${encodeURIComponent(`import ${JSON.stringify(abs)};`)}`,
        options,
      )
    const blob = new Blob([`importScripts(${JSON.stringify(abs)});`], { type: 'text/javascript' })
    return new Native(URL.createObjectURL(blob), options)
  }
  ShimWorker.prototype = Native.prototype
  w.Worker = ShimWorker
  // The engine's single-file build also carries every worker as one string (`CESIUM_WORKERS`) and, when it believes the worker URL is
  // its own origin, starts a classic `blob:` worker that runs `importScripts(blob:)`: `script-src` has no `blob:` (and must not), so
  // that worker dies silently and the globe never gets a mesh. Pinning the global to `undefined` makes the engine always start its
  // module workers, which the shim above wraps.
  Object.defineProperty(w, 'CESIUM_WORKERS', {
    get: () => undefined,
    set: () => {},
    configurable: false,
  })

  // The engine bundles knockout, which finds the global object with `this || (0, eval)("this")` when it loads; the page's CSP has no
  // 'unsafe-eval' (and must not), so that line would throw and stop the engine. This `eval` answers only that question and runs no
  // code: any other string is refused as the CSP would refuse it.
  w.eval = /** @param {unknown} src */ (src) => {
    if (src === 'this') return window
    if (typeof src !== 'string') return src
    throw new EvalError('eval is not allowed on this page')
  }
})()

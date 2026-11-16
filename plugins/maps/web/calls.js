// Calls from the map window to its plugin's operations through the bridge (`call` out, `result` in; the SPA runs them, ADR-0038 §6).

/** @typedef {{ ok: boolean, value?: unknown, error?: string | undefined }} CallResult */

/** @param {(msg: unknown) => void} post the bridge's `postMessage` to the parent */
export function createCalls(post) {
  /** @type {Map<string, (result: CallResult) => void>} */
  const pending = new Map()
  let seq = 0
  return {
    /** @param {string} operation @param {unknown} input @returns {Promise<CallResult>} */
    call(operation, input) {
      return new Promise((resolve) => {
        const id = `c${++seq}`
        pending.set(id, resolve)
        post({ v: 1, type: 'call', id, operation, input })
      })
    },
    /** Settles the call a `result` message answers. @param {Record<string, unknown>} msg */
    result(msg) {
      if (typeof msg.id !== 'string') return
      const resolve = pending.get(msg.id)
      pending.delete(msg.id)
      resolve?.({
        ok: msg.ok === true,
        value: msg.value,
        error: typeof msg.error === 'string' ? msg.error : undefined,
      })
    },
  }
}

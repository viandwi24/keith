// The data loop of the map window: which layers are on, when each is due again (its refresh, or a moved view for a layer of the view),
// and one `layers` call at a time for all that are due. A window may make 30 bridge calls a minute: calls are at least 2.5 s apart, so
// a moving person and live layers stay under it with room for a route.

import { layerOf } from './catalog.js'

const MIN_GAP_MS = 2_500
/** A moved view asks again this long after it settles. */
const MOVED_MS = 1_200
/** How soon an empty answer with a note (still loading, a source that was slow) is asked again. */
const RETRY_MS = 15_000

/**
 * @param {{
 *   call: (op: string, input: unknown) => Promise<import('./calls.js').CallResult>,
 *   features: ReturnType<typeof import('./features.js').createFeatures>,
 *   panel: ReturnType<typeof import('./layer-panel.js').createLayerPanel>,
 *   query: () => { bbox: [number, number, number, number], zoom: number } | undefined,
 * }} deps
 */
export function createDataLoop(deps) {
  /** @type {Set<string>} */
  const on = new Set()
  /** @type {Map<string, number>} */
  const due = new Map()
  let inflight = false
  let lastCall = 0

  /** @param {string[]} ids */
  function setLayers(ids) {
    for (const id of [...on]) {
      if (ids.includes(id)) continue
      on.delete(id)
      due.delete(id)
      deps.features.clear(id)
    }
    for (const id of ids) {
      if (on.has(id) || layerOf(id) === undefined) continue
      on.add(id)
      due.set(id, 0)
      deps.panel.state(id, 'busy', '…')
    }
    deps.panel.set([...on])
  }

  /** The view moved: the layers of the view are due once it settles. */
  function moved() {
    const at = Date.now() + MOVED_MS
    for (const id of on) {
      if (layerOf(id)?.world === true) continue
      due.set(id, Math.min(due.get(id) ?? at, at))
    }
  }

  async function step() {
    const now = Date.now()
    if (deps.features.anyMoving()) deps.features.tick()
    if (inflight || now - lastCall < MIN_GAP_MS || on.size === 0) return
    const q = deps.query()
    if (q === undefined) return
    /** @type {string[]} */
    const ids = []
    for (const id of on) {
      const info = layerOf(id)
      if (info === undefined || (due.get(id) ?? 0) > now) continue
      if (q.zoom < info.minZoom) {
        deps.features.clear(id)
        deps.panel.state(id, 'idle', 'zoom in')
        due.set(id, now + info.refreshS * 1000)
        continue
      }
      ids.push(id)
    }
    if (ids.length === 0) return
    inflight = true
    lastCall = now
    for (const id of ids) deps.panel.state(id, 'busy')
    try {
      const result = await deps.call('layers', { ids, bbox: q.bbox, zoom: Math.round(q.zoom) })
      const answers = readAnswers(result.ok ? result.value : undefined)
      for (const id of ids) {
        const info = layerOf(id)
        due.set(id, Date.now() + (info?.refreshS ?? 60) * 1000)
        if (!on.has(id)) continue
        const a = answers.find((x) => x.id === id)
        if (!result.ok || a === undefined) {
          deps.panel.state(id, 'failed', result.ok ? 'no answer' : 'failed')
          continue
        }
        if (a.error !== undefined) {
          deps.panel.state(id, 'failed', a.error.slice(0, 40))
          continue
        }
        deps.features.set(a)
        const n = a.features.length
        // a source still loading (satellite elements) is asked again soon, not after its whole refresh
        if (n === 0 && a.note !== undefined && a.raster === undefined)
          due.set(id, Math.min(due.get(id) ?? 0, Date.now() + RETRY_MS))
        deps.panel.state(
          id,
          'ok',
          a.note !== undefined && n === 0 ? a.note.slice(0, 40) : String(n),
        )
      }
    } finally {
      inflight = false
    }
  }

  const timer = setInterval(() => void step(), 1_000)
  return { setLayers, moved, layers: () => [...on], stop: () => clearInterval(timer), step }
}

/**
 * The `layers` answer, read by hand: each layer's id, features with finite positions, an optional raster, note and error.
 * @param {unknown} value
 * @returns {import('./features.js').LayerAnswer[]}
 */
export function readAnswers(value) {
  if (typeof value !== 'object' || value === null) return []
  const list = /** @type {{ layers?: unknown }} */ (value).layers
  if (!Array.isArray(list)) return []
  /** @type {import('./features.js').LayerAnswer[]} */
  const out = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const a = /** @type {Record<string, unknown>} */ (raw)
    if (typeof a.id !== 'string') continue
    const features = Array.isArray(a.features)
      ? a.features.filter(
          (f) =>
            typeof f === 'object' &&
            f !== null &&
            Number.isFinite(/** @type {{ lat?: unknown }} */ (f).lat) &&
            Number.isFinite(/** @type {{ lon?: unknown }} */ (f).lon),
        )
      : []
    /** @type {import('./features.js').LayerAnswer} */
    const answer = {
      id: a.id,
      features: /** @type {import('./features.js').Feature[]} */ (features).map(cleanFeature),
    }
    const r = /** @type {Record<string, unknown> | undefined} */ (a.raster)
    if (
      typeof r === 'object' &&
      r !== null &&
      typeof r.template === 'string' &&
      isNetPath(r.template.replaceAll(/\{[xyz]\}/g, '0'))
    )
      answer.raster = {
        template: r.template,
        maxZoom: typeof r.maxZoom === 'number' ? r.maxZoom : 8,
        ...(typeof r.alpha === 'number' ? { alpha: r.alpha } : {}),
      }
    if (typeof a.note === 'string') answer.note = a.note
    if (typeof a.error === 'string') answer.error = a.error
    out.push(answer)
  }
  return out
}

/**
 * A feature with only the media the page may load: an image through the core's net route, a stream over https.
 * @param {import('./features.js').Feature} f
 */
function cleanFeature(f) {
  const out = { ...f }
  if (typeof out.image !== 'string' || !isNetPath(out.image)) delete out.image
  if (typeof out.stream !== 'string' || !out.stream.startsWith('https://')) delete out.stream
  if (typeof out.label === 'string') out.label = out.label.slice(0, 80)
  return out
}

/**
 * Whether a path goes through the core's net route and nowhere else: `../net/<host>/<path>` with plain path characters, no `..`
 * segment (which would climb out of the route) and no query.
 * @param {string} s
 */
export function isNetPath(s) {
  return (
    /^\.\.\/net\/[A-Za-z0-9.-]{1,253}\/[A-Za-z0-9._~@=,+\-/]{0,512}$/.test(s) &&
    !s.slice(7).split('/').includes('..')
  )
}

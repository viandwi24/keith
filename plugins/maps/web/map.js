// The `maps:map` window: a CesiumJS globe that morphs to a flat map and back (ADR-0040), inside a sandboxed iframe (ADR-0038 §6). It
// talks to the SPA only through the bridge (version 1): `ready` on load, `init`, `params` and `result` in, `setParams`, `setTitle`,
// `error` and `call` out (`route` for a route's line and facts, `layers` for the data layers). The engine is globe.js and features.js;
// the panels are panel.js (route), layers.js (style, credits), layer-panel.js (data), card.js (a picked thing) and draw.js (marks).

import { createCalls } from './calls.js'
import { createCard } from './card.js'
import { createDataLoop } from './data.js'
import { createDraw } from './draw.js'
import { createFeatures } from './features.js'
import { Cesium, createGlobe } from './globe.js'
import { createLayerPanel } from './layer-panel.js'
import { createCredits, createLayers } from './layers.js'
import { createOverlay } from './overlay.js'
import { createRoutePanel, readAnswer } from './panel.js'
import { fitKey, pinsOf, readParams } from './params.js'
import { DEFAULT_STYLE, previewUrl, styleName, styleOf } from './styles.js'
import { fitView, offsetPoint, round6 } from './tiles.js'

const V = 1
const SETTLE_MS = 400
/** The zoom a picked step is shown at (at least). */
const STEP_ZOOM = 16
/** Pixels kept free around a fitted route or pins. */
/** The room kept around a fitted route or pins: 12 % of the room's short side, at least 64 px (the A and B labels need it). @param {number} w @param {number} h */
const fitPad = (w, h) => Math.max(64, Math.round(Math.min(w, h) * 0.12))
const FLY_S = 0.9

/** @param {string} id */
const byId = (id) => /** @type {HTMLElement} */ (document.getElementById(id))
const map = byId('map')
const marker = byId('marker')
const labelEl = byId('label')
const stepMark = byId('step-mark')
const zoomEl = byId('zoom-level')
const fitButton = byId('fit')
const viewButton = byId('view-btn')
/** @param {unknown} msg */
const post = (msg) => window.parent.postMessage(msg, '*')
const calls = createCalls(post)

const globe = createGlobe(byId('globe'), {
  onMoveEnd: () => onMoveEnd(),
  onFrame: () => drawOverlay(),
  onError: (title) => post({ v: V, type: 'error', message: `globe: ${title}`.slice(0, 200) }),
  onPinch: () => personMoves(),
})
const features = createFeatures(globe)
const overlay = createOverlay({ pins: byId('pins') })

/** The marked place (the params point). @type {{ lat: number, lon: number } | undefined} */
let mark
/** @type {string | undefined} */
let label
/** The params as last applied, re-sent with every `setParams`. @type {import('./params.js').MapParams | undefined} */
let current
let style = DEFAULT_STYLE
/** The route whose line is drawn or being fetched (its fit key), whether it is being fetched, and whether the view still follows it. */
let routeKey = ''
let routeLoading = false
let autoFit = false
/** The line of the drawn route. @type {[number, number][]} */
let line = []
/** The step picked in the route panel. @type {[number, number] | undefined} */
let stepAt
/** The picked feature, and whether the camera follows it. @type {{ layer: string, feature: import('./features.js').Feature } | undefined} */
let picked
let following = false
/** Set by a press or a wheel on the globe: the next stop of the camera is the person's move (it ends following the route). */
let touched = false

const size = () => ({ w: map.clientWidth || 1, h: map.clientHeight || 1 })

function drawOverlay() {
  const { w } = size()
  overlay.draw((lat, lon) => globe.toScreen(lat, lon), w)
  const showMark =
    mark !== undefined && current?.route === undefined && current?.places.length === 0
  const m = showMark && mark !== undefined ? globe.toScreen(mark.lat, mark.lon) : undefined
  marker.hidden = m === undefined
  if (m !== undefined) {
    marker.style.left = `${m.x}px`
    marker.style.top = `${m.y}px`
  }
  const s = stepAt === undefined ? undefined : globe.toScreen(stepAt[0], stepAt[1])
  stepMark.hidden = s === undefined
  if (s !== undefined) stepMark.style.transform = `translate(${s.x}px, ${s.y}px)`
  labelEl.textContent = label ?? ''
  const v = globe.getView()
  zoomEl.textContent = `Z${Math.round(v.zoom * 10) / 10} · ${globe.mode().toUpperCase()}`
}

const layers = createLayers({
  // one menu at a time, so the open one has the whole column
  onOpen: () => layerPanel.close(),
  onPick(name) {
    setStyle(name)
    moved(autoFit)
  },
  preview: (name) => {
    const v = globe.getView()
    return previewUrl(v.lat, v.lon, v.zoom, name)
  },
})
const credits = createCredits()

/** @param {string} next */
function setStyle(next) {
  const name = styleName(next)
  layers.set(name)
  credits.set(name)
  document.documentElement.dataset.tone = styleOf(name).dark ? 'dark' : 'light'
  if (name === style && styled) return
  style = name
  styled = true
  globe.setStyle(name)
}
let styled = false

/** Points to fit once the map has a size. @type {{ lat: number, lon: number }[] | undefined} */
let pendingFit
/**
 * Centres the view on these points at the zoom that shows them all, in the free room beside or below the route panel.
 * @param {{ lat: number, lon: number }[]} points @param {number} [seconds]
 */
function fitTo(points, seconds = FLY_S) {
  const { w, h } = size()
  // not laid out yet (a frame drawn before its box has a size): fit once it has one
  if (w < 64 || h < 64) {
    pendingFit = points
    return
  }
  pendingFit = undefined
  /** @type {{ left: number, right: number, top: number, at: ReturnType<typeof fitView> } | undefined} */
  let best
  for (const room of rooms()) {
    const rw = w - room.left - room.right
    const rh = h - room.top
    const at = fitView(points, rw, rh, fitPad(rw, rh), 17)
    if (at !== undefined && (best?.at === undefined || at.zoom > best.at.zoom))
      best = { ...room, at }
  }
  if (best?.at === undefined) return
  const { left, right, top, at } = best
  const c = offsetPoint(at.lat, at.lon, at.zoom, -(left - right) / 2, -top / 2)
  globe.setView({ lat: c.lat, lon: c.lon, zoom: at.zoom }, seconds)
}

/**
 * The ways the route panel can leave room for a fit: on a wide window the map right of the panel or the map below it (the panel sits
 * in the top left corner), on a narrow one the map below it; the controls keep a strip on the right either way.
 */
function rooms() {
  const panel = byId('route')
  const { w } = size()
  if (panel.hidden) return [{ left: 0, right: w > 560 ? 90 : 0, top: 0 }]
  const wide = w > 560
  const side = {
    left: wide ? panel.offsetWidth + 10 : 0,
    right: wide ? 90 : 0,
    top: wide ? 0 : panel.offsetHeight + 10,
  }
  if (!wide) return [side]
  return [side, { left: 0, right: 90, top: panel.offsetHeight + 10 }]
}

/** What the fit button shows: the route's line, else its stops and the pins. */
const fitPoints = () =>
  line.length > 1 ? line.map(([lat, lon]) => ({ lat, lon })) : current ? pinsOf(current) : []

const panel = createRoutePanel({
  onMode(mode) {
    if (current?.route === undefined) return
    const route = { ...current.route, mode }
    current = { ...current, route }
    autoFit = true
    startRoute(route)
    moved(true)
  },
  onStep(at) {
    stepAt = at
    if (at !== undefined) {
      const zoom = Math.max(globe.getView().zoom, STEP_ZOOM)
      const room = rooms()[0] ?? { left: 0, right: 0, top: 0 }
      const c = offsetPoint(at[0], at[1], zoom, -(room.left - room.right) / 2, -room.top / 2)
      globe.setView({ lat: c.lat, lon: c.lon, zoom }, 0.6)
      autoFit = false
    }
    globe.render()
  },
})

/** @param {NonNullable<import('./params.js').MapParams['route']>} route */
function startRoute(route) {
  if (current === undefined) return
  routeKey = fitKey({ ...current, places: [] })
  void loadRoute(route, routeKey)
}

/**
 * Asks the `route` operation for the route of the params (its line, time, distance and steps); a newer route wins over an older answer.
 * @param {NonNullable<import('./params.js').MapParams['route']>} route @param {string} key
 */
async function loadRoute(route, key) {
  routeLoading = true
  panel.loading(route)
  const at = (/** @type {{ lat: number, lon: number }} */ p) => ({ lat: p.lat, lon: p.lon })
  const result = await calls.call('route', {
    from: at(route.from),
    to: at(route.to),
    via: route.via.length > 0 ? route.via.map(at) : undefined,
    mode: route.mode,
    geometry: true,
  })
  if (key !== routeKey) return
  routeLoading = false
  const answer = result.ok ? readAnswer(result.value) : undefined
  if (answer === undefined) {
    line = []
    globe.setRoute(undefined)
    panel.fail(route, String(result.error ?? 'the route service gave no answer'))
    return
  }
  line = answer.line
  globe.setRoute(line)
  panel.show(route, answer)
  if (autoFit && line.length > 1) {
    fitTo(fitPoints())
    moved(true)
  }
}

/** The scene the person picked with the 2D/3D button, and when. @type {{ view: '2d' | '3d', at: number } | undefined} */
let chosen
/** How long the person's pick outweighs params that still carry the old scene. */
const CHOSEN_MS = 5_000

let applied = false
/** @param {import('./params.js').MapParams} params */
function apply(params) {
  const first = !applied
  applied = true
  current = params
  setStyle(params.style)
  const view = params.view === '2d' ? '2d' : '3d'
  // the person's own switch wins for a while: params that still carry the old scene (the host's copy from before the switch) do not
  // morph back
  const chosenLately = chosen !== undefined && Date.now() - chosen.at < CHOSEN_MS
  if (first) globe.morph(view, 0)
  else if (!chosenLately || view === chosen?.view) globe.morph(view)
  viewButton.textContent = globe.wanted() === '2d' ? '3D' : '2D'
  mark = { lat: params.lat, lon: params.lon }
  if (params.label !== label) {
    label = params.label
    if (label !== undefined) post({ v: V, type: 'setTitle', title: label })
  }
  overlay.setPins(pinsOf(params))
  draw.set(params.marks)
  data.setLayers(params.layers)
  credits.layers(data.layers())
  const key = fitKey(params)
  fitButton.hidden = key === ''
  if (params.route === undefined) {
    routeKey = ''
    routeLoading = false
    line = []
    stepAt = undefined
    globe.setRoute(undefined)
    panel.hide()
  }
  // a new route or new pins: fit the view to them, and keep following the route's line until the person moves the map (an echo of
  // our own params while the route loads keeps following)
  autoFit = key !== '' && (params.fitted !== key || (autoFit && routeLoading))
  if (autoFit) {
    fitTo(pinsOf(params), first ? 0 : FLY_S)
    moved(true)
  } else if (!echo(params)) {
    globe.setView({ lat: params.lat, lon: params.lon, zoom: params.zoom }, first ? 0 : FLY_S)
  }
  if (params.route !== undefined && fitKey({ ...params, places: [] }) !== routeKey) {
    startRoute(params.route)
  }
  globe.render()
}

/** The params we last proposed: an echo of them must not move the camera again. @type {string} */
let lastSent = ''
/** @param {import('./params.js').MapParams} params */
const echo = (params) =>
  lastSent !== '' &&
  lastSent === JSON.stringify([round6(params.lat), round6(params.lon), params.zoom])

/** @type {ReturnType<typeof setTimeout> | undefined} */
let settle
/**
 * Tells the host where the map is now, 400 ms after it settles, with the view, the route, the pins, the layers, the marks and what
 * the view was fitted to. A move by the person (`auto` false) stops the view from following the route.
 * @param {boolean} [auto]
 */
function moved(auto = false) {
  if (!auto) autoFit = false
  data.moved()
  clearTimeout(settle)
  settle = setTimeout(() => {
    const v = globe.getView()
    /** @type {Record<string, unknown>} */
    const params = { lat: v.lat, lon: v.lon, zoom: v.zoom }
    lastSent = JSON.stringify([v.lat, v.lon, v.zoom])
    if (label !== undefined) params.label = label
    if (style !== DEFAULT_STYLE) params.style = style
    if (globe.wanted() === '2d') params.view = '2d'
    const on = data.layers()
    if (on.length > 0) params.layers = on
    if (current?.route !== undefined) {
      const { via, ...rest } = current.route
      params.route = via.length > 0 ? { ...rest, via } : rest
    }
    if (current !== undefined && current.places.length > 0) params.places = current.places
    if (current !== undefined && current.marks.length > 0) params.marks = current.marks
    if (current !== undefined) {
      const key = fitKey(current)
      if (key !== '') params.fitted = key
    }
    post({ v: V, type: 'setParams', params })
  }, SETTLE_MS)
}

function onMoveEnd() {
  const byPerson = touched
  touched = false
  moved(!byPerson)
}

const layerPanel = createLayerPanel({
  onOpen: () => layers.close(),
  onToggle(id, on) {
    const now = data.layers()
    data.setLayers(on ? [...now, id] : now.filter((x) => x !== id))
    credits.layers(data.layers())
    if (!on && picked?.layer === id) unpick()
    moved(autoFit)
  },
})
const data = createDataLoop({
  call: (op, input) => calls.call(op, input),
  features,
  panel: layerPanel,
  query() {
    const r = globe.camera.computeViewRectangle(globe.scene.globe.ellipsoid)
    if (r === undefined) return undefined
    const deg = Cesium.Math.toDegrees
    const round = (/** @type {number} */ n) => Math.round(n * 1e4) / 1e4
    /** @type {[number, number, number, number]} */
    const bbox = [round(deg(r.south)), round(deg(r.north)), round(deg(r.west)), round(deg(r.east))]
    return { bbox, zoom: globe.getView().zoom }
  },
})
const draw = createDraw(globe, {
  onChange(marks) {
    if (current === undefined) return
    current = { ...current, marks }
    moved(autoFit)
  },
})

const card = createCard({
  onClose: () => unpick(),
  onFollow(on) {
    following = on
  },
  onFocus() {
    if (picked === undefined) return
    const f = picked.feature
    globe.setView({ lat: f.lat, lon: f.lon, zoom: Math.max(globe.getView().zoom, 12) }, FLY_S)
  },
})

function unpick() {
  picked = undefined
  following = false
  features.pick(undefined, undefined)
  card.hide()
}

// clicks: a feature opens its card; with a drawing tool picked the ground takes a point
const clicks = new Cesium.ScreenSpaceEventHandler(globe.canvas)
clicks.setInputAction((/** @type {{ position: import('cesium').Cartesian2 }} */ e) => {
  if (draw.active()) {
    const at = globe.toGround(e.position.x, e.position.y)
    if (at !== undefined) draw.click(at)
    return
  }
  const hit = features.featureAt(e.position.x, e.position.y)
  if (hit === undefined) {
    unpick()
    return
  }
  picked = hit
  features.pick(hit.layer, hit.feature)
  card.show(hit.layer, hit.feature)
}, Cesium.ScreenSpaceEventType.LEFT_CLICK)
clicks.setInputAction(() => {
  if (draw.active()) draw.finish()
}, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
/** A press, a wheel or a pinch on the globe: the person moves the map (it stops following the route and a picked thing). */
function personMoves() {
  touched = true
  following = false
  layers.close()
  layerPanel.close()
}
for (const type of ['pointerdown', 'wheel']) {
  globe.canvas.addEventListener(type, personMoves, { passive: true })
}

// the camera follows a picked moving thing (an aircraft, a satellite) while Follow is on
setInterval(() => {
  if (!following || picked === undefined) return
  const at = features.positionOf(picked.layer, picked.feature)
  globe.setView({ lat: at.lat, lon: at.lon, zoom: globe.getView().zoom }, 0)
}, 1_000)

byId('zoom-in').addEventListener('click', () => {
  touched = true
  globe.zoomBy(1)
})
byId('zoom-out').addEventListener('click', () => {
  touched = true
  globe.zoomBy(-1)
})
byId('north').addEventListener('click', () => globe.resetNorth())
fitButton.addEventListener('click', () => {
  fitTo(fitPoints())
  moved()
})
viewButton.addEventListener('click', () => {
  const next = globe.wanted() === '2d' ? '3d' : '2d'
  chosen = { view: next, at: Date.now() }
  globe.morph(next)
  viewButton.textContent = next === '2d' ? '3D' : '2D'
  if (current !== undefined) current = { ...current, view: next }
  // tell the host now, not after the morph: its copy of the params must stop saying the old scene
  moved(autoFit)
})

// a new size while the view still follows the route (or waits for a size to fit): fit again
new ResizeObserver(() => {
  if (autoFit) {
    fitTo(pendingFit ?? fitPoints(), 0)
    moved(true)
  }
  globe.render()
}).observe(map)

// the bridge: only the parent window speaks to this frame
window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return
  const msg = e.data
  if (typeof msg !== 'object' || msg === null || msg.v !== V) return
  if (msg.type === 'init') {
    if (msg.theme === 'dark' || msg.theme === 'light') {
      document.documentElement.dataset.theme = msg.theme
    }
    if (typeof msg.language === 'string') document.documentElement.lang = msg.language.slice(0, 16)
  }
  if (msg.type === 'result') {
    calls.result(msg)
    return
  }
  if (msg.type === 'init' || msg.type === 'params') {
    const params = readParams(msg.params)
    if (params !== undefined) apply(params)
  }
})

// the whole globe until the host sends params
globe.setView({ lat: 0, lon: 110, zoom: 2 })
setStyle(DEFAULT_STYLE)
post({ v: V, type: 'ready' })

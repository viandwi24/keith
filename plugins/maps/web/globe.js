// The engine of the map window: a CesiumJS globe (ADR-0040) that morphs between the 3D globe and a flat 2D map without losing the
// view. It owns the camera, the base map style, the route line and the marks; the data layers are drawn by features.js on the same
// scene. Only this file and features.js speak Cesium.

import { styleOf, templateOf } from './styles.js'
import { heightForZoom, round6, spanForZoom, zoomForHeight, zoomForSpan } from './tiles.js'

/** The engine, loaded by its own script before this module (map.html). @type {typeof import('cesium')} */
export const Cesium = /** @type {any} */ (globalThis).Cesium

// In the sandboxed frame the page's origin is opaque, so every image from the core is cross-origin to it; the engine judges by
// `location` (which still shows the core) and loads images without `crossOrigin`, and WebGL then refuses the tainted texture. Every
// image is asked for with CORS instead: the core answers its plugin files and its net route with `Access-Control-Allow-Origin: *`.
// (Tests import the pure helpers of the page without the engine.)
if (/** @type {unknown} */ (Cesium) !== undefined) {
  const impl = /** @type {any} */ (Cesium.Resource)._Implementations
  const createImage = impl.createImage
  impl.createImage = (
    /** @type {unknown} */ request,
    /** @type {unknown} */ _crossOrigin,
    /** @type {unknown[]} */ ...rest
  ) => createImage.call(impl, request, true, ...rest)
}

/** @typedef {{ lat: number, lon: number, zoom: number }} View */

/**
 * Hides, on the 3D globe, every billboard and label of these collections that is behind the Earth: they are drawn without the depth
 * test (an icon on the ground must not be cut by the surface), so without this the far side shows through. Runs before each frame;
 * in 2D (and during a morph) everything shows. A hidden one cannot be picked.
 * @param {import('cesium').Scene} scene
 * @param {() => Iterable<import('cesium').BillboardCollection | import('cesium').LabelCollection>} collections
 */
export function hideBehindGlobe(scene, collections) {
  const occluder = new Cesium.EllipsoidalOccluder(scene.globe.ellipsoid, scene.camera.positionWC)
  scene.preRender.addEventListener(() => {
    const on3d = scene.mode === Cesium.SceneMode.SCENE3D
    if (on3d) occluder.cameraPosition = scene.camera.positionWC
    for (const c of collections()) {
      for (let i = 0; i < c.length; i++) {
        const item = c.get(i)
        const visible = !on3d || occluder.isPointVisible(item.position)
        if (item.show !== visible) item.show = visible
      }
    }
  })
}

/** The zoom a switch between the globe and the flat map happens at (the whole Earth in view), and the crossfade between them. */
const SWITCH_ZOOM = 2.6
const FADE_MS = 420
/** A flight's length: longer for more zoom levels, within bounds. @param {number} levels */
const flightSeconds = (levels) => Math.min(1.6, Math.max(0.45, 0.3 + Math.abs(levels) * 0.13))
/** The camera never goes nearer the ground than this, nor farther than about three Earths. */
const MIN_DISTANCE_M = 40
const MAX_DISTANCE_M = 40_000_000

/**
 * @param {HTMLElement} container
 * @param {{ onMoveEnd: () => void, onFrame: () => void, onError: (title: string) => void, onPinch?: () => void }} handlers `onFrame` runs after each drawn frame (the DOM overlay follows it); `onPinch` on each step of a trackpad pinch
 */
export function createGlobe(container, handlers) {
  const credits = document.createElement('div')
  credits.hidden = true
  const widget = new Cesium.CesiumWidget(container, {
    baseLayer: false,
    mapProjection: new Cesium.WebMercatorProjection(),
    sceneMode: Cesium.SceneMode.SCENE3D,
    creditContainer: credits,
    requestRenderMode: true,
    maximumRenderTimeChange: Number.POSITIVE_INFINITY,
    useBrowserRecommendedResolution: true,
    msaaSamples: 4,
  })
  const { scene, camera } = widget
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b0f14')
  scene.backgroundColor = Cesium.Color.BLACK
  scene.globe.showGroundAtmosphere = true
  scene.globe.enableLighting = false
  scene.highDynamicRange = false
  if (scene.skyAtmosphere !== undefined) scene.skyAtmosphere.show = true
  scene.fog.enabled = true
  // the engine's own error panel needs inline styles: a failed frame goes to the host as a bridge `error` instead
  widget.showErrorPanel = (
    /** @type {string} */ title,
    /** @type {unknown} */ _message,
    /** @type {unknown} */ error,
  ) => handlers.onError(error instanceof Error ? `${title} ${error.message}` : title)
  const control = scene.screenSpaceCameraController
  control.minimumZoomDistance = MIN_DISTANCE_M
  control.maximumZoomDistance = MAX_DISTANCE_M
  control.inertiaSpin = 0.85
  control.inertiaZoom = 0.6
  // a trackpad pinch: the page zooms itself (the engine ignores a ctrl-wheel and Safari's gesture events)
  pinchGestures(widget.canvas, (scale, at) => {
    handlers.onPinch?.()
    zoomScale(scale, at)
  })
  camera.moveEnd.addEventListener(() => handlers.onMoveEnd())
  scene.postRender.addEventListener(() => handlers.onFrame())
  /** The view to come back to when a morph ends: the engine's morph lands on its own default view, not where the person was. @type {View | undefined} */
  let keep
  /** The scene the page wants: a morph asked for while another one runs waits for it to end (the engine would start from a half-morphed camera). @type {'2d' | '3d'} */
  let wanted = '3d'
  /** Set while the page's own switch runs (zoom out, swap, zoom in): the engine's instant morph inside it is not a morph of its own. */
  let switching = false
  scene.morphComplete.addEventListener(() => {
    if (switching) return
    inMorph = false
    if (keep !== undefined) place(keep)
    keep = undefined
    scene.requestRender()
    handlers.onMoveEnd()
  })

  const canvas = widget.canvas
  const long = () => Math.max(canvas.clientWidth, canvas.clientHeight, 1)

  // the route: a soft glow over a dark casing
  const lines = new Cesium.PolylineCollection()
  scene.primitives.add(lines)
  /** @type {import('cesium').Polyline[]} */
  let routeLines = []
  let styleDark = true

  /** @param {string} name */
  function setStyle(name) {
    const s = styleOf(name)
    styleDark = s.dark
    const layers = scene.imageryLayers
    // the data layers' rasters (rain, imagery) stay above the base: only the base and its labels are swapped
    for (const layer of [...baseLayers]) layers.remove(layer, true)
    baseLayers = []
    const base = new Cesium.UrlTemplateImageryProvider({
      url: templateOf(s.base),
      maximumLevel: s.base.maxZoom,
      credit: s.short,
    })
    baseLayers.push(layers.addImageryProvider(base, 0))
    if (s.labels !== undefined) {
      const labels = new Cesium.UrlTemplateImageryProvider({
        url: templateOf(s.labels),
        maximumLevel: s.labels.maxZoom,
      })
      baseLayers.push(layers.addImageryProvider(labels, 1))
    }
    scene.globe.baseColor = Cesium.Color.fromCssColorString(s.dark ? '#0b0f14' : '#dfe3e8')
    // the ground atmosphere washes a dark map out to pale blue; the sky ring around the globe stays
    scene.globe.showGroundAtmosphere = !s.dark
    restyleRoute()
    scene.requestRender()
  }
  /** @type {import('cesium').ImageryLayer[]} */
  let baseLayers = []

  /** @param {[number, number][] | undefined} line */
  function setRoute(line) {
    for (const l of routeLines) lines.remove(l)
    routeLines = []
    if (line !== undefined && line.length > 1) {
      const positions = Cesium.Cartesian3.fromDegreesArray(line.flatMap(([lat, lon]) => [lon, lat]))
      routeLines.push(
        lines.add({ positions, width: 9, material: Cesium.Material.fromType('Color') }),
        lines.add({ positions, width: 12, material: Cesium.Material.fromType('PolylineGlow') }),
      )
      restyleRoute()
    }
    scene.requestRender()
  }

  function restyleRoute() {
    const [casing, glow] = routeLines
    if (casing === undefined || glow === undefined) return
    casing.material.uniforms.color = styleDark
      ? Cesium.Color.fromCssColorString('#0b0b14').withAlpha(0.75)
      : Cesium.Color.WHITE.withAlpha(0.9)
    glow.material.uniforms.color = Cesium.Color.fromCssColorString(
      styleDark ? '#a5b4fc' : '#4f46e5',
    )
    glow.material.uniforms.glowPower = 0.18
  }

  /** @returns {'2d' | '3d'} */
  const mode = () => (scene.mode === Cesium.SceneMode.SCENE2D ? '2d' : '3d')
  // from the call until `morphComplete`: the engine first animates the flat camera for a while still in SCENE2D, and a camera move then
  // cancels the morph
  let inMorph = false
  const morphing = () => inMorph || scene.mode === Cesium.SceneMode.MORPHING

  /**
   * Looks straight down at a point from the height of a zoom level; `seconds` flies there.
   * @param {View} view @param {number} [seconds]
   */
  function setView(view, seconds = 0) {
    // moving the camera mid-switch breaks it: the view is where it lands instead
    if (morphing()) {
      keep = { lat: view.lat, lon: view.lon, zoom: view.zoom }
      return
    }
    place(view, seconds)
  }

  /**
   * Puts the camera straight down over a view (north up); `seconds` flies there, and the promise ends when it is there (or the
   * flight was cut short).
   * @param {View} view @param {number} [seconds] @returns {Promise<void>}
   */
  function place(view, seconds = 0) {
    // in 2D the engine makes the frustum as wide as the height: the projected width of the canvas at this zoom (`zoomForSpan`'s
    // inverse); in 3D the height that shows the ground at this zoom's scale
    const height =
      scene.mode === Cesium.SceneMode.SCENE2D
        ? spanForZoom(view.zoom, canvas.clientWidth)
        : heightForZoom(view.zoom, view.lat, long())
    const destination = Cesium.Cartesian3.fromDegrees(view.lon, view.lat, height)
    const orientation = { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 }
    scene.requestRender()
    if (seconds <= 0) {
      camera.setView({ destination, orientation })
      return Promise.resolve()
    }
    return new Promise((done) => {
      camera.flyTo({
        destination,
        orientation,
        duration: seconds,
        easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
        complete: () => done(),
        cancel: () => done(),
      })
    })
  }

  /** Where the camera looks now: the point under the canvas centre and its zoom. @returns {View} */
  function getView() {
    // a half-morphed camera says nothing useful: while a morph runs the view is the one it started from (and will end on)
    if (morphing() && keep !== undefined) return keep
    if (scene.mode === Cesium.SceneMode.SCENE2D) {
      const c = camera.positionCartographic
      const f = /** @type {import('cesium').OrthographicOffCenterFrustum} */ (camera.frustum)
      return {
        lat: round6(Cesium.Math.toDegrees(c.latitude)),
        lon: round6(Cesium.Math.toDegrees(c.longitude)),
        zoom: zoomForSpan((f.right ?? 0) - (f.left ?? 0), canvas.clientWidth),
      }
    }
    const centre = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2)
    const hit = camera.pickEllipsoid(centre, scene.globe.ellipsoid)
    if (hit === undefined) {
      const c = camera.positionCartographic
      const lat = Cesium.Math.toDegrees(c.latitude)
      return {
        lat: round6(lat),
        lon: round6(Cesium.Math.toDegrees(c.longitude)),
        zoom: zoomForHeight(c.height, lat, long()),
      }
    }
    const c = Cesium.Cartographic.fromCartesian(hit)
    const lat = Cesium.Math.toDegrees(c.latitude)
    return {
      lat: round6(lat),
      lon: round6(Cesium.Math.toDegrees(c.longitude)),
      zoom: zoomForHeight(Cesium.Cartesian3.distance(camera.positionWC, hit), lat, long()),
    }
  }

  /**
   * Morphs to `next`; `seconds` 0 jumps there (the caller sets the view after). A morph asked for while one runs follows it.
   * @param {'2d' | '3d'} next @param {number} [seconds]
   */
  function morph(next, seconds = 1) {
    wanted = next
    if (morphing() || next === mode()) return
    startMorph(next, seconds)
  }
  /**
   * The switch. The engine's own animated morph always swings the camera to lat 0, lon 0 far out and lands there, so the page does
   * it in three steps instead: fly out above the same point until the whole Earth shows (in 3D this also turns the globe to face it,
   * north up), swap the scene at once under a crossfade of the last frame, and fly back in to the view. A view set meanwhile (the
   * route's fit, the host's params) becomes where it lands; the camera ignores the person until it is there.
   * @param {'2d' | '3d'} next @param {number} [seconds] 0 swaps at once (the first params; the caller sets the view)
   */
  async function startMorph(next, seconds = 1) {
    if (seconds <= 0) {
      if (next === '2d') scene.morphTo2D(0)
      else scene.morphTo3D(0)
      return
    }
    keep ??= getView()
    inMorph = true
    switching = true
    control.enableInputs = false
    try {
      const out = Math.min(keep.zoom, SWITCH_ZOOM)
      if (keep.zoom - out > 0.05 || scene.mode === Cesium.SceneMode.SCENE3D)
        await place({ ...keep, zoom: out }, flightSeconds(keep.zoom - out))
      const shot = snapshot()
      if (next === '2d') scene.morphTo2D(0)
      else scene.morphTo3D(0)
      place({ ...keep, zoom: out })
      widget.render()
      fadeOut(shot, next)
      const target = keep
      await place(target, flightSeconds(target.zoom - out))
      // a view set during the last flight: go there too
      if (keep !== target) await place(keep, flightSeconds(keep.zoom - target.zoom))
    } finally {
      control.enableInputs = true
      switching = false
      inMorph = false
    }
    keep = undefined
    if (wanted !== mode()) {
      void startMorph(wanted)
      return
    }
    scene.requestRender()
    handlers.onMoveEnd()
  }

  /** The frame on screen now, as a canvas laid over the globe (drawn right after a render, while the WebGL buffer still holds it). */
  function snapshot() {
    const shot = document.createElement('canvas')
    shot.className = 'switch-shot'
    shot.width = canvas.width
    shot.height = canvas.height
    scene.requestRender()
    widget.render()
    shot.getContext('2d')?.drawImage(canvas, 0, 0)
    container.appendChild(shot)
    return shot
  }

  /** Fades the last frame of the old scene out over the new one (the flat map shrinks into the globe, the globe opens into the map). @param {HTMLCanvasElement} shot @param {'2d' | '3d'} next */
  function fadeOut(shot, next) {
    shot.classList.add(next === '3d' ? 'to-globe' : 'to-map')
    // the class change must land in a frame of its own for the transition to run
    requestAnimationFrame(() => requestAnimationFrame(() => shot.classList.add('gone')))
    setTimeout(() => shot.remove(), FADE_MS + 100)
  }

  /** The canvas pixel of a point, or undefined when it is off screen or behind the globe. @param {number} lat @param {number} lon @param {number} [alt] */
  function toScreen(lat, lon, alt = 0) {
    const p = Cesium.Cartesian3.fromDegrees(lon, lat, alt)
    if (scene.mode === Cesium.SceneMode.SCENE3D) {
      const occluder = new Cesium.EllipsoidalOccluder(scene.globe.ellipsoid, camera.positionWC)
      if (!occluder.isPointVisible(p)) return undefined
    }
    const s = Cesium.SceneTransforms.worldToWindowCoordinates(scene, p)
    if (s === undefined) return undefined
    if (s.x < -50 || s.y < -50 || s.x > canvas.clientWidth + 50 || s.y > canvas.clientHeight + 50)
      return undefined
    return { x: s.x, y: s.y }
  }

  /** The ground point under a canvas pixel. @param {number} x @param {number} y */
  function toGround(x, y) {
    const hit = camera.pickEllipsoid(new Cesium.Cartesian2(x, y), scene.globe.ellipsoid)
    if (hit === undefined) return undefined
    const c = Cesium.Cartographic.fromCartesian(hit)
    return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) }
  }

  /**
   * Zooms by a factor (2 = twice as near) toward a canvas pixel (the fingers of a pinch; the centre when none or over space), within
   * the camera's limits.
   * @param {number} scale @param {{ x: number, y: number }} [at]
   */
  function zoomScale(scale, at) {
    if (morphing() || !Number.isFinite(scale) || scale <= 0) return
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const x = at?.x ?? w / 2
    const y = at?.y ?? h / 2
    if (scene.mode === Cesium.SceneMode.SCENE2D) {
      const f = /** @type {import('cesium').OrthographicOffCenterFrustum} */ (camera.frustum)
      const width = (f.right ?? 0) - (f.left ?? 0)
      const next = Math.min(MAX_DISTANCE_M, Math.max(MIN_DISTANCE_M, width / scale))
      const shift = 1 - next / width
      const metresPerPx = width / Math.max(w, 1)
      // in 2D the engine narrows the frustum by the amount
      camera.zoomIn(width - next)
      // keep the point under the fingers where it is
      camera.moveRight((x - w / 2) * metresPerPx * shift)
      camera.moveDown((y - h / 2) * metresPerPx * shift)
    } else {
      const pixel = new Cesium.Cartesian2(x, y)
      let target = camera.pickEllipsoid(pixel, scene.globe.ellipsoid)
      let direction = target === undefined ? undefined : camera.getPickRay(pixel)?.direction
      if (target === undefined || direction === undefined) {
        const centre = new Cesium.Cartesian2(w / 2, h / 2)
        target = camera.pickEllipsoid(centre, scene.globe.ellipsoid)
        direction = camera.direction
      }
      const now =
        target === undefined
          ? camera.positionCartographic.height
          : Cesium.Cartesian3.distance(camera.positionWC, target)
      const next = Math.min(MAX_DISTANCE_M, Math.max(MIN_DISTANCE_M, now / scale))
      camera.move(direction, now - next)
    }
    scene.requestRender()
  }

  /** Zooms in or out by whole levels from the current view. @param {number} delta */
  function zoomBy(delta) {
    if (morphing()) return
    const v = getView()
    const next = delta > 0 ? Math.floor(v.zoom + 1e-6) + delta : Math.ceil(v.zoom - 1e-6) + delta
    const h = heightForZoom(Math.max(1, Math.min(19, next)), v.lat, long())
    if (scene.mode === Cesium.SceneMode.SCENE2D) {
      setView({ ...v, zoom: next }, 0.3)
      return
    }
    // keep the camera's tilt and heading: move along the line of sight to the new distance
    const target = camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      scene.globe.ellipsoid,
    )
    if (target === undefined) {
      setView({ ...v, zoom: next }, 0.3)
      return
    }
    const now = Cesium.Cartesian3.distance(camera.positionWC, target)
    camera.zoomIn(now - h)
    scene.requestRender()
    handlers.onMoveEnd()
  }

  /** Points the camera north and straight down again. */
  function resetNorth() {
    setView(getView(), 0.6)
  }

  return {
    scene,
    camera,
    canvas,
    setStyle,
    setRoute,
    setView,
    getView,
    morph,
    mode,
    /** The scene the page is in or morphing to. */
    wanted: () => wanted,
    toScreen,
    toGround,
    zoomBy,
    resetNorth,
    /** Whether the route line and labels read on a dark map. */
    dark: () => styleDark,
    render: () => scene.requestRender(),
  }
}

/** @typedef {ReturnType<typeof createGlobe>} Globe */

/** How much one pixel of a pinch's ctrl-wheel zooms: 100 px is a factor of e (about 1.4 levels). */
const PINCH_PER_PX = 0.01

/**
 * A trackpad pinch. Chrome, Firefox and Edge send it as a wheel with ctrlKey (small pixel deltas, many a second); Safari as
 * `gesture*` events (the scale since the start, plus the pinch centre). Both zoom toward the fingers; the engine never sees them (it
 * would ignore a ctrl-wheel, and the browser would zoom the page).
 * @param {HTMLElement} target @param {(scale: number, at: { x: number, y: number }) => void} zoom
 */
function pinchGestures(target, zoom) {
  /** @param {{ clientX: number, clientY: number }} e */
  const pixelOf = (e) => {
    const r = target.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey || e.target !== target) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY
      zoom(Math.exp(-px * PINCH_PER_PX), pixelOf(e))
    },
    { capture: true, passive: false },
  )
  let last = 1
  /** @param {Event} e */
  const gestureOf = (e) =>
    /** @type {{ scale?: unknown, clientX?: unknown, clientY?: unknown }} */ (e)
  target.addEventListener('gesturestart', (e) => {
    e.preventDefault()
    last = 1
  })
  target.addEventListener('gesturechange', (e) => {
    e.preventDefault()
    const { scale, clientX, clientY } = gestureOf(e)
    if (typeof scale !== 'number' || scale <= 0) return
    const at =
      typeof clientX === 'number' && typeof clientY === 'number'
        ? pixelOf({ clientX, clientY })
        : { x: target.clientWidth / 2, y: target.clientHeight / 2 }
    zoom(scale / last, at)
    last = scale
  })
  target.addEventListener('gestureend', (e) => e.preventDefault())
}

// The route panel of the map window: travel modes, time, distance, arrival, average speed, the stops and the turn-by-turn steps of
// the `route` operation's answer. Picking a mode asks for the route again (the map does it); picking a step centres the map on it.

/** @typedef {[number, number]} LatLon */
/** @typedef {{ text: string, distanceM?: number, at?: LatLon }} RouteStep */
/**
 * @typedef {{ distanceM: number, durationS: number, mode: string, provider: string, note?: string, steps: RouteStep[],
 *   line: LatLon[] }} RouteAnswer
 */

const PROVIDERS = /** @type {Record<string, string>} */ ({
  osrm: 'OSRM · FOSSGIS',
  valhalla: 'Valhalla · FOSSGIS',
})

const finite = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v)
/** @param {unknown} p @returns {p is LatLon} */
const isLatLon = (p) => Array.isArray(p) && finite(p[0]) && finite(p[1])

/**
 * Reads the `route` operation's answer by hand (the page has no zod); undefined when it has no distance or time.
 * @param {unknown} value
 * @returns {RouteAnswer | undefined}
 */
export function readAnswer(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const v = /** @type {Record<string, unknown>} */ (value)
  if (!finite(v.distanceM) || !finite(v.durationS)) return undefined
  /** @type {RouteStep[]} */
  const steps = []
  for (const raw of Array.isArray(v.steps) ? v.steps.slice(0, 60) : []) {
    if (typeof raw !== 'object' || raw === null) continue
    const s = /** @type {Record<string, unknown>} */ (raw)
    if (typeof s.text !== 'string') continue
    /** @type {RouteStep} */
    const step = { text: s.text.slice(0, 200) }
    if (finite(s.distanceM)) step.distanceM = /** @type {number} */ (s.distanceM)
    if (isLatLon(s.at)) step.at = [s.at[0], s.at[1]]
    steps.push(step)
  }
  /** @type {RouteAnswer} */
  const out = {
    distanceM: /** @type {number} */ (v.distanceM),
    durationS: /** @type {number} */ (v.durationS),
    mode: typeof v.mode === 'string' ? v.mode : 'car',
    provider: typeof v.provider === 'string' ? v.provider : '',
    steps,
    line: Array.isArray(v.geometry) ? v.geometry.filter(isLatLon) : [],
  }
  if (typeof v.note === 'string' && v.note !== '') out.note = v.note.slice(0, 160)
  return out
}

/** @param {number} m @returns {string} `850 m`, `5.1 km`, `49 km` */
export function formatDistance(m) {
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`
  const km = m / 1000
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`
}

/** @param {number} s @returns {string} `45 s`, `6 min`, `1 h 52 min` */
export function formatDuration(s) {
  if (s < 60) return `${Math.max(0, Math.round(s))} s`
  const min = Math.round(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const rest = min % 60
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`
}

/**
 * The local arrival time when leaving now: `14:32`, with `+1d` past midnight.
 * @param {Date} now @param {number} durationS
 */
export function arrival(now, durationS) {
  const at = new Date(now.getTime() + durationS * 1000)
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')
  const days = Math.round(
    (new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000,
  )
  return `${pad(at.getHours())}:${pad(at.getMinutes())}${days > 0 ? ` +${days}d` : ''}`
}

/** @param {number} m @param {number} s @returns {string} the average speed, `32 km/h` */
export function averageSpeed(m, s) {
  if (s <= 0) return '—'
  return `${Math.round(m / 1000 / (s / 3600))} km/h`
}

/** A glyph for a step's maneuver, read from its English text. @param {string} text */
export function turnOf(text) {
  const t = text.toLowerCase()
  if (t.startsWith('start') || t.startsWith('drive') || t.startsWith('head')) return '●'
  if (t.startsWith('arrive') || t.includes('destination') || t.includes('you have arrived'))
    return '◎'
  if (t.includes('u-turn') || t.includes('uturn')) return '↶'
  if (t.includes('roundabout') || t.includes('rotary')) return '↻'
  if (/\b(slight|keep|bear) left\b/.test(t)) return '↖'
  if (/\b(slight|keep|bear) right\b/.test(t)) return '↗'
  if (/\bleft\b/.test(t)) return '↰'
  if (/\bright\b/.test(t)) return '↱'
  if (t.includes('ramp') || t.includes('exit')) return '↗'
  return '↑'
}

/** @param {{ lat: number, lon: number, label?: string }} p */
const placeText = (p) => p.label ?? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

/**
 * @param {{ onMode: (mode: string) => void, onStep: (at: LatLon | undefined) => void }} handlers
 */
export function createRoutePanel(handlers) {
  const root = el('route')
  const status = el('r-status')
  const metrics = el('r-metrics')
  const stops = el('r-stops')
  const note = el('r-note')
  const toggle = el('r-steps-toggle')
  const list = el('r-steps')
  const provider = el('r-provider')
  const fold = el('r-fold')
  const modeButtons = /** @type {HTMLButtonElement[]} */ ([
    ...root.querySelectorAll('.modes button'),
  ])
  /** @type {HTMLButtonElement | undefined} */
  let picked

  for (const b of modeButtons) {
    b.addEventListener('click', () => {
      const mode = b.dataset.mode ?? 'car'
      if (b.getAttribute('aria-pressed') !== 'true') handlers.onMode(mode)
    })
  }
  fold.addEventListener('click', () => {
    const folded = root.classList.toggle('folded')
    fold.setAttribute('aria-expanded', String(!folded))
  })
  toggle.addEventListener('click', () => {
    const open = list.hidden
    list.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    toggle.lastElementChild?.replaceChildren(open ? '▴' : '▾')
  })
  // the panel takes its own wheel and drag: the map under it stays put
  for (const type of ['pointerdown', 'wheel', 'dblclick']) {
    root.addEventListener(type, (e) => e.stopPropagation(), { passive: true })
  }

  /** @param {string} mode */
  const setMode = (mode) => {
    for (const b of modeButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === mode))
  }

  /** @param {import('./params.js').RouteParams} route */
  const drawStops = (route) => {
    const all = [
      { p: route.from, kind: 'from', mark: 'A' },
      ...route.via.map((p, i) => ({ p, kind: 'via', mark: String(i + 1) })),
      { p: route.to, kind: 'to', mark: 'B' },
    ]
    stops.replaceChildren(
      ...all.map(({ p, kind, mark }) => {
        const li = document.createElement('li')
        li.className = kind
        const badge = document.createElement('span')
        badge.className = 'badge'
        badge.textContent = mark
        const name = document.createElement('span')
        name.className = p.label === undefined ? 'name coord' : 'name'
        name.textContent = placeText(p)
        name.title = placeText(p)
        li.append(badge, name)
        return li
      }),
    )
  }

  /** @param {RouteStep[]} steps */
  const drawSteps = (steps) => {
    picked = undefined
    handlers.onStep(undefined)
    toggle.hidden = steps.length === 0
    const label = document.createElement('span')
    label.textContent = `Directions · ${steps.length} steps`
    const caret = document.createElement('span')
    caret.textContent = list.hidden ? '▾' : '▴'
    toggle.replaceChildren(label, caret)
    list.replaceChildren(
      ...steps.map((step) => {
        const li = document.createElement('li')
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'step'
        b.disabled = step.at === undefined
        const turn = document.createElement('span')
        turn.className = 'turn'
        turn.textContent = turnOf(step.text)
        const text = document.createElement('span')
        text.className = 'text'
        text.textContent = step.text
        const len = document.createElement('span')
        len.className = 'len'
        len.textContent =
          step.distanceM === undefined || step.distanceM === 0 ? '' : formatDistance(step.distanceM)
        b.append(turn, text, len)
        b.addEventListener('click', () => {
          picked?.removeAttribute('aria-current')
          if (picked === b) {
            picked = undefined
            handlers.onStep(undefined)
            return
          }
          picked = b
          b.setAttribute('aria-current', 'true')
          handlers.onStep(step.at)
        })
        li.appendChild(b)
        return li
      }),
    )
  }

  /** @param {'busy' | 'failed' | 'ok'} state @param {string} [text] */
  const setState = (state, text = '') => {
    root.classList.toggle('busy', state === 'busy')
    root.classList.toggle('failed', state === 'failed')
    status.textContent = text
    status.hidden = text === ''
  }

  return {
    /** @param {import('./params.js').RouteParams} route */
    loading(route) {
      root.hidden = false
      setMode(route.mode)
      drawStops(route)
      setState('busy', metrics.dataset.filled === 'true' ? '' : 'Finding the route…')
      metrics.hidden = metrics.dataset.filled !== 'true'
    },
    /** @param {import('./params.js').RouteParams} route @param {RouteAnswer} answer */
    show(route, answer) {
      root.hidden = false
      setState('ok')
      setMode(answer.mode)
      drawStops(route)
      el('r-time').textContent = formatDuration(answer.durationS)
      el('r-dist').textContent = formatDistance(answer.distanceM)
      el('r-eta').textContent = arrival(new Date(), answer.durationS)
      el('r-speed').textContent = averageSpeed(answer.distanceM, answer.durationS)
      metrics.hidden = false
      metrics.dataset.filled = 'true'
      provider.textContent = PROVIDERS[answer.provider] ?? answer.provider
      note.textContent = answer.note === undefined ? '' : `Note: ${answer.note}`
      note.hidden = answer.note === undefined
      drawSteps(answer.steps)
    },
    /** @param {import('./params.js').RouteParams} route @param {string} message */
    fail(route, message) {
      root.hidden = false
      setMode(route.mode)
      drawStops(route)
      setState('failed', `No route: ${message.slice(0, 140)}`)
      metrics.hidden = true
      metrics.dataset.filled = 'false'
      provider.textContent = ''
      note.hidden = true
      drawSteps([])
    },
    hide() {
      root.hidden = true
      metrics.dataset.filled = 'false'
      handlers.onStep(undefined)
    },
  }
}

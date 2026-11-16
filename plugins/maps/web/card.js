// The card of a picked feature: what it is, its facts, a camera's snapshot (refreshed while open), a radio's player, and a button that
// keeps the camera on a moving thing.

import { layerOf } from './catalog.js'

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

const SNAPSHOT_MS = 20_000

/**
 * @param {{ onClose: () => void, onFollow: (on: boolean) => void, onFocus: () => void }} handlers
 */
export function createCard(handlers) {
  const root = el('card')
  const tag = el('card-tag')
  const title = el('card-title')
  const facts = el('card-facts')
  const media = el('card-media')
  const follow = /** @type {HTMLButtonElement} */ (el('card-follow'))
  const focus = /** @type {HTMLButtonElement} */ (el('card-focus'))
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let refresh
  /** @type {HTMLAudioElement | undefined} */
  let audio

  const stop = () => {
    clearInterval(refresh)
    refresh = undefined
    audio?.pause()
    audio = undefined
  }
  el('card-close').addEventListener('click', () => {
    hide()
    handlers.onClose()
  })
  follow.addEventListener('click', () => {
    const on = follow.getAttribute('aria-pressed') !== 'true'
    follow.setAttribute('aria-pressed', String(on))
    handlers.onFollow(on)
  })
  focus.addEventListener('click', () => handlers.onFocus())
  for (const type of ['pointerdown', 'wheel', 'dblclick']) {
    root.addEventListener(type, (e) => e.stopPropagation(), { passive: true })
  }

  function hide() {
    stop()
    root.hidden = true
    follow.setAttribute('aria-pressed', 'false')
  }

  /**
   * @param {string} layer @param {import('./features.js').Feature} f
   */
  function show(layer, f) {
    stop()
    const info = layerOf(layer)
    root.hidden = false
    root.style.setProperty('--c', info?.color ?? '#a5b4fc')
    tag.textContent = `${info?.glyph ?? '•'} ${info?.title ?? layer}${f.kind === undefined ? '' : ` · ${f.kind}`}`
    title.textContent = f.label ?? info?.title ?? layer
    /** @type {[string, string][]} */
    const rows = Object.entries(f.info ?? {}).map(([k, v]) => [k, String(v)])
    rows.push(['Position', `${f.lat.toFixed(4)}, ${f.lon.toFixed(4)}`])
    facts.replaceChildren(
      ...rows.slice(0, 12).map(([k, v]) => {
        const dt = document.createElement('dt')
        dt.textContent = k
        const dd = document.createElement('dd')
        dd.textContent = v
        dd.title = v
        const row = document.createElement('div')
        row.append(dt, dd)
        return row
      }),
    )
    media.replaceChildren()
    if (f.image !== undefined && f.rect === undefined) {
      const img = document.createElement('img')
      img.alt = f.label ?? 'Camera snapshot'
      img.referrerPolicy = 'no-referrer'
      img.decoding = 'async'
      const src = f.image
      img.src = src
      media.appendChild(img)
      // a camera that is off (or a feed that is down) answers 404: say so instead of a broken image; a later frame brings it back
      const off = document.createElement('p')
      off.className = 'card-off'
      off.textContent = 'No snapshot from this camera right now'
      off.hidden = true
      media.appendChild(off)
      img.addEventListener('error', () => {
        img.hidden = true
        off.hidden = false
      })
      img.addEventListener('load', () => {
        img.hidden = false
        off.hidden = true
      })
      // a snapshot camera publishes a new frame every few seconds: ask again while the card is open (the core keeps a live frame 20 s; the query only defeats the browser's cache)
      refresh = setInterval(() => {
        img.src = `${src}${src.includes('?') ? '&' : '?'}t=${Date.now()}`
      }, SNAPSHOT_MS)
    }
    if (f.stream !== undefined) {
      const a = document.createElement('audio')
      a.controls = true
      a.preload = 'none'
      a.src = f.stream
      media.appendChild(a)
      audio = a
      void a.play().catch(() => {})
    }
    const moves = f.track !== undefined || f.speed !== undefined
    follow.hidden = !moves
    follow.setAttribute('aria-pressed', 'false')
  }

  return { show, hide, shown: () => !root.hidden }
}

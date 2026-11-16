// The map window's style picker (a grid of previews, one per style) and its credits: a short line always on the map and the full
// attribution behind ⓘ (OpenStreetMap asks for visible credit; the full text is one tap away).

import { layerOf } from './catalog.js'
import { STYLES, styleOf } from './styles.js'

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

/**
 * @param {{ onPick: (name: string) => void, preview: (name: string) => string, onOpen?: () => void }} handlers `preview` gives the URL of a tile of the
 *   current place in that style
 */
export function createLayers(handlers) {
  const button = el('layers-btn')
  const panel = el('layers')
  const title = document.createElement('p')
  title.className = 'layers-title'
  title.textContent = 'Map style'
  /** @type {{ name: string, b: HTMLButtonElement, img: HTMLImageElement }[]} */
  const items = Object.entries(STYLES).map(([name, s]) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('aria-pressed', 'false')
    const img = document.createElement('img')
    img.className = 'swatch'
    img.alt = ''
    img.decoding = 'async'
    img.referrerPolicy = 'no-referrer'
    const label = document.createElement('span')
    label.className = 'layer-name'
    label.textContent = s.label
    b.append(img, label)
    b.addEventListener('click', () => {
      handlers.onPick(name)
      close()
    })
    return { name, b, img }
  })
  panel.replaceChildren(title, ...items.map((i) => i.b))

  const close = () => {
    panel.hidden = true
    button.setAttribute('aria-expanded', 'false')
  }
  button.addEventListener('click', () => {
    if (!panel.hidden) return close()
    handlers.onOpen?.()
    for (const i of items) i.img.src = handlers.preview(i.name)
    panel.hidden = false
    button.setAttribute('aria-expanded', 'true')
  })
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close()
      button.focus()
    }
  })
  for (const type of ['pointerdown', 'wheel', 'dblclick']) {
    panel.addEventListener(type, (e) => e.stopPropagation(), { passive: true })
  }

  return {
    close,
    /** @param {string} name */
    set(name) {
      for (const i of items) i.b.setAttribute('aria-pressed', String(i.name === name))
    },
  }
}

export function createCredits() {
  const short = el('credit-short')
  const full = el('credit-full')
  const button = el('credit-btn')
  button.addEventListener('click', () => {
    const open = full.hidden
    full.hidden = !open
    short.hidden = open
    button.setAttribute('aria-expanded', String(open))
  })
  let style = ''
  /** @type {string[]} */
  let on = []
  const draw = () => {
    const s = styleOf(style)
    const extra = [...new Set(on.map((id) => layerOf(id)?.credit).filter((c) => c !== undefined))]
    short.textContent = extra.length === 0 ? s.short : `${s.short} · +${extra.length}`
    full.textContent = [s.credit, ...extra].join(' · ')
  }
  return {
    /** The base style's credit. @param {string} name */
    set(name) {
      style = name
      draw()
    },
    /** The credits of the data layers that are on. @param {string[]} ids */
    layers(ids) {
      on = ids
      draw()
    },
  }
}

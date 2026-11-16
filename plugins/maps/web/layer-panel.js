// The data layer panel of the map window: the layers grouped (Movement, Space, Events, Weather, Cameras, Audio, Imagery), each a
// toggle with its glyph, its state (how many shown, "zoom in", "needs a setting", an error) and its source.

import { GROUPS, LAYERS } from './catalog.js'

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

/**
 * @param {{ onToggle: (id: string, on: boolean) => void, onOpen?: () => void }} handlers
 */
export function createLayerPanel(handlers) {
  const button = el('data-btn')
  const panel = el('data-layers')
  const count = el('data-count')
  /** @type {Map<string, { b: HTMLButtonElement, state: HTMLElement }>} */
  const rows = new Map()
  const title = document.createElement('p')
  title.className = 'layers-title'
  title.textContent = 'Data layers'
  /** @type {HTMLElement[]} */
  const parts = [title]
  for (const [group, name] of Object.entries(GROUPS)) {
    const layers = LAYERS.filter((l) => l.group === group)
    if (layers.length === 0) continue
    const head = document.createElement('p')
    head.className = 'group-title'
    head.textContent = name
    parts.push(head)
    for (const l of layers) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'data-row'
      b.setAttribute('aria-pressed', 'false')
      b.title = `${l.about} · ${l.credit}`
      b.style.setProperty('--c', l.color)
      const glyph = document.createElement('span')
      glyph.className = 'glyph'
      glyph.textContent = l.glyph
      const name = document.createElement('span')
      name.className = 'data-name'
      name.textContent = l.title
      const state = document.createElement('span')
      state.className = 'data-state'
      b.append(glyph, name, state)
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true'
        handlers.onToggle(l.id, on)
      })
      rows.set(l.id, { b, state })
      parts.push(b)
    }
  }
  panel.replaceChildren(...parts)

  const close = () => {
    panel.hidden = true
    button.setAttribute('aria-expanded', 'false')
  }
  button.addEventListener('click', () => {
    if (!panel.hidden) return close()
    handlers.onOpen?.()
    panel.hidden = false
    button.setAttribute('aria-expanded', 'true')
  })
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close()
      button.focus()
    }
  })

  return {
    close,
    /** @param {string[]} on */
    set(on) {
      for (const [id, r] of rows) {
        const pressed = on.includes(id)
        r.b.setAttribute('aria-pressed', String(pressed))
        if (!pressed) {
          r.state.textContent = ''
          r.b.classList.remove('busy', 'failed')
        }
      }
      count.textContent = on.length === 0 ? '' : String(on.length)
      count.hidden = on.length === 0
    },
    /**
     * @param {string} id @param {'busy' | 'ok' | 'failed' | 'idle'} kind @param {string} [text]
     */
    state(id, kind, text = '') {
      const r = rows.get(id)
      if (r === undefined) return
      r.b.classList.toggle('busy', kind === 'busy')
      r.b.classList.toggle('failed', kind === 'failed')
      if (kind !== 'busy' || r.state.textContent === '') r.state.textContent = text
    },
  }
}

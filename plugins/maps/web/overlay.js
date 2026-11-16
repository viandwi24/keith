// What the map window draws over the globe as HTML: the pins of a route's stops and of places, with their labels in the HUD style.
// Their screen positions come from the globe after every frame (a pin behind the globe or off screen is hidden).

/** @typedef {{ lat: number, lon: number, label?: string, kind: 'from' | 'to' | 'via' | 'place', mark: string }} OverlayPin */
/** @typedef {(lat: number, lon: number) => { x: number, y: number } | undefined} ToScreen */

/** @param {{ pins: HTMLElement }} els */
export function createOverlay(els) {
  /** @type {{ pin: OverlayPin, el: HTMLElement }[]} */
  let pins = []
  return {
    /** @param {OverlayPin[]} next */
    setPins(next) {
      els.pins.replaceChildren()
      pins = next.map((pin) => {
        const el = document.createElement('div')
        el.className = `dot dot-${pin.kind}`
        const badge = document.createElement('span')
        badge.className = 'badge'
        badge.textContent = pin.mark
        el.appendChild(badge)
        if (pin.label !== undefined) {
          const text = document.createElement('span')
          text.className = 'dot-label'
          text.textContent = pin.label
          el.appendChild(text)
          el.title = pin.label
        }
        els.pins.appendChild(el)
        return { pin, el }
      })
    },
    /** @param {ToScreen} toScreen @param {number} width */
    draw(toScreen, width) {
      for (const { pin, el } of pins) {
        const p = toScreen(pin.lat, pin.lon)
        el.hidden = p === undefined
        if (p === undefined) continue
        // a label that would run past the right edge goes on the left of its badge (the badge stays on the point)
        const w = el.offsetWidth
        const flip = w > 24 && p.x - 10 + w > width - 6 && p.x - w + 10 > 6
        el.classList.toggle('flip', flip)
        const left = flip ? p.x - w + 20 : p.x
        el.style.transform = `translate(${Math.round(left)}px, ${Math.round(p.y)}px)`
      }
    },
  }
}

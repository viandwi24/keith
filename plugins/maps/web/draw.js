// Director mode: marks drawn on the map by the person (or set by Keith through the params): pins, lines and areas with a label and a
// colour. The toolbar picks a tool; a click on the ground adds a point; Done (or a double click, or Enter) ends a line or an area.
// The marks live in the params, so Keith sees them and can add its own.

import { Cesium, hideBehindGlobe } from './globe.js'
import { badgeIcon } from './icons.js'
import { MARK_COLORS, MAX_MARK_POINTS, MAX_MARKS } from './params.js'

/** @type {Record<string, string>} */
export const MARK_CSS = {
  indigo: '#a5b4fc',
  red: '#f87171',
  amber: '#fbbf24',
  green: '#4ade80',
  cyan: '#22d3ee',
  white: '#f5f5f5',
}

/** @param {string} id */
const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id))

/**
 * @param {import('./globe.js').Globe} globe
 * @param {{ onChange: (marks: import('./params.js').Mark[]) => void }} handlers
 */
export function createDraw(globe, handlers) {
  const { scene } = globe
  const bar = el('draw')
  const toggle = el('draw-btn')
  const labelInput = /** @type {HTMLInputElement} */ (el('draw-label'))
  const done = /** @type {HTMLButtonElement} */ (el('draw-done'))
  const tools = /** @type {HTMLButtonElement[]} */ ([...bar.querySelectorAll('[data-tool]')])
  const colors = /** @type {HTMLButtonElement[]} */ ([...bar.querySelectorAll('[data-color]')])
  /** @type {import('./params.js').Mark[]} */
  let marks = []
  /** @type {'pin' | 'line' | 'area' | undefined} */
  let tool
  let color = 'amber'
  /** @type {[number, number][]} */
  let draft = []

  const lines = new Cesium.PolylineCollection()
  const pins = new Cesium.BillboardCollection({ scene })
  const labels = new Cesium.LabelCollection({ scene })
  /** @type {import('cesium').Primitive[]} */
  let fills = []
  scene.primitives.add(lines)
  scene.primitives.add(pins)
  scene.primitives.add(labels)
  hideBehindGlobe(scene, () => [pins, labels])

  /** @param {'pin' | 'line' | 'area' | undefined} next */
  function setTool(next) {
    tool = next
    draft = []
    for (const b of tools) b.setAttribute('aria-pressed', String(b.dataset.tool === next))
    done.hidden = next === undefined || next === 'pin'
    redraw()
  }
  for (const b of tools) {
    b.addEventListener('click', () => {
      const t = /** @type {'pin' | 'line' | 'area'} */ (b.dataset.tool)
      setTool(tool === t ? undefined : t)
    })
  }
  for (const b of colors) {
    b.style.setProperty('--c', MARK_CSS[b.dataset.color ?? 'amber'] ?? '#fbbf24')
    b.addEventListener('click', () => {
      color = MARK_COLORS.find((c) => c === b.dataset.color) ?? 'amber'
      for (const o of colors) o.setAttribute('aria-pressed', String(o === b))
    })
  }
  done.addEventListener('click', () => finish())
  el('draw-undo').addEventListener('click', () => {
    if (draft.length > 0) draft.pop()
    else marks = marks.slice(0, -1)
    redraw()
    if (draft.length === 0) handlers.onChange(marks)
  })
  el('draw-clear').addEventListener('click', () => {
    marks = []
    draft = []
    redraw()
    handlers.onChange(marks)
  })
  toggle.addEventListener('click', () => {
    const open = bar.hidden
    bar.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    if (!open) setTool(undefined)
  })
  // the left column (route, card) and the menus end above the open toolbar: it sits 26px up, the column 24px up, 8px apart
  new ResizeObserver(() => {
    const h = bar.hidden ? 0 : bar.offsetHeight + 10
    document.body.style.setProperty('--draw-h', `${h}px`)
  }).observe(bar)
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === labelInput) finish()
  })
  for (const type of ['pointerdown', 'wheel', 'dblclick']) {
    bar.addEventListener(type, (e) => e.stopPropagation(), { passive: true })
  }

  const used = () => marks.reduce((n, m) => n + m.points.length, 0)

  /** Ends the line or area being drawn (when it has enough points). */
  function finish() {
    if (tool === undefined) return
    const need = tool === 'pin' ? 1 : tool === 'line' ? 2 : 3
    if (draft.length >= need && marks.length < MAX_MARKS) {
      /** @type {import('./params.js').Mark} */
      const mark = { kind: tool, points: tool === 'pin' ? draft.slice(0, 1) : draft, color }
      const text = labelInput.value.trim().slice(0, 40)
      if (text !== '') mark.label = text
      marks = [...marks, mark]
      labelInput.value = ''
      handlers.onChange(marks)
    }
    draft = []
    redraw()
  }

  /**
   * A click on the ground while a tool is picked; false when no tool is (the click is the map's).
   * @param {{ lat: number, lon: number }} at
   */
  function click(at) {
    if (tool === undefined) return false
    if (used() + draft.length >= MAX_MARK_POINTS) return true
    draft = [...draft, [Math.round(at.lat * 1e5) / 1e5, Math.round(at.lon * 1e5) / 1e5]]
    if (tool === 'pin') finish()
    else redraw()
    return true
  }

  function redraw() {
    lines.removeAll()
    pins.removeAll()
    labels.removeAll()
    for (const f of fills) scene.primitives.remove(f)
    fills = []
    const all = [...marks]
    if (draft.length > 0 && tool !== undefined)
      all.push({ kind: tool, points: draft, color, label: '' })
    for (const m of all) {
      const css = MARK_CSS[m.color ?? 'amber'] ?? '#fbbf24'
      const c = Cesium.Color.fromCssColorString(css)
      const positions = Cesium.Cartesian3.fromDegreesArray(m.points.flatMap(([la, lo]) => [lo, la]))
      const head = positions[0]
      if (head === undefined) continue
      if (m.kind === 'pin' || m.points.length === 1) {
        pins.add({ position: head, image: badgeIcon('⬤', css, 18), scale: 0.6 })
      } else {
        const closed = m.kind === 'area' && m.points.length > 2
        lines.add({
          positions: closed ? [...positions, positions[0]] : positions,
          width: 3,
          material: Cesium.Material.fromType('Color', { color: c }),
        })
        if (closed) {
          fills.push(
            scene.primitives.add(
              new Cesium.Primitive({
                geometryInstances: new Cesium.GeometryInstance({
                  geometry: new Cesium.PolygonGeometry({
                    polygonHierarchy: new Cesium.PolygonHierarchy(positions),
                  }),
                  attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(c.withAlpha(0.22)),
                  },
                }),
                appearance: new Cesium.PerInstanceColorAppearance({
                  flat: true,
                  translucent: true,
                }),
                asynchronous: false,
              }),
            ),
          )
        }
      }
      if (m.label !== undefined && m.label !== '') {
        labels.add({
          position: head,
          text: m.label,
          font: '12px ui-monospace, SFMono-Regular, Menlo, monospace',
          fillColor: c,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.9),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(12, -12),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        })
      }
    }
    scene.requestRender()
  }

  return {
    click,
    finish,
    /** @param {import('./params.js').Mark[]} next the params' marks (Keith's or an echo of ours) */
    set(next) {
      marks = next
      redraw()
    },
    /** Whether a tool is picked (the map's own clicks wait). */
    active: () => tool !== undefined,
  }
}

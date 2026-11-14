import { describe, expect, test } from 'bun:test'
import { chatOrbBox } from './chat-orb-box.ts'
import { CHAT_ORB_BOX, flightEnds, homeOrbBox } from './features/home/orb-flight.ts'
import { layoutOf, sidebarBox } from './layout.ts'
import { orbMaxRows, orbRowsFor } from './sidebar.tsx'

const base = { header: true, margin: 1, cellAspect: 0.46, showBrain: true, showTasks: true }

describe('the chat end of the Home flight', () => {
  test('wide: the sidebar orb, at the right edge, as wide as the sidebar', () => {
    const rows = 40
    const box = chatOrbBox(120, { ...base, rows, sidebarPref: undefined })
    const layout = layoutOf(120, { rows })
    const side = sidebarBox(layout, { rows, margin: 1, headerOn: true, inChat: true })
    expect(box).toEqual({
      top: side.top + 1,
      left: 120 - 2 - layout.sidebar,
      width: layout.sidebar,
      height: orbRowsFor(side.height, {
        max: orbMaxRows(layout.sidebar, 0.46),
        brain: true,
        tasks: true,
      }),
    })
    expect(box?.left).toBeGreaterThan(60)
  })

  test('the flight runs between Home and that box, both ways', () => {
    const box = chatOrbBox(120, { ...base, rows: 40, sidebarPref: undefined })
    if (box === undefined) throw new Error('no sidebar orb')
    const home = homeOrbBox(120, 40, 0.46)
    expect(flightEnds('in', 120, 40, 0.46, box)).toEqual({ from: home, to: box })
    expect(flightEnds('out', 120, 40, 0.46, box)).toEqual({ from: box, to: home })
  })

  test('small: no sidebar, the header corner is the origin', () => {
    expect(chatOrbBox(90, { ...base, rows: 30, sidebarPref: undefined })).toBeUndefined()
    expect(flightEnds('out', 90, 30, 0.46, undefined).from).toEqual(CHAT_ORB_BOX)
  })

  test('wide with the sidebar hidden (ctrl+b): the header corner too', () => {
    expect(chatOrbBox(120, { ...base, rows: 40, sidebarPref: false })).toBeUndefined()
  })

  test('wide but under 40 rows the orb stays in the header', () => {
    expect(chatOrbBox(120, { ...base, rows: 30, sidebarPref: undefined })).toBeUndefined()
  })
})

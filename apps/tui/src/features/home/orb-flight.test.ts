import { describe, expect, test } from 'bun:test'
import { homeSize } from './home-state.ts'
import { CHAT_ORB_BOX, FLIGHT_STEPS, flightBox, flightEnds, homeOrbBox } from './orb-flight.ts'

describe('flightBox', () => {
  const home = homeOrbBox(120, 40)

  test('starts at the source and ends at the target', () => {
    expect(flightBox(home, CHAT_ORB_BOX, 0)).toEqual(home)
    expect(flightBox(home, CHAT_ORB_BOX, FLIGHT_STEPS)).toEqual(CHAT_ORB_BOX)
  })

  test('shrinks monotonically on the way in', () => {
    const sizes = Array.from({ length: FLIGHT_STEPS + 1 }, (_, i) =>
      flightBox(home, CHAT_ORB_BOX, i),
    ).map((b) => b.height)
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1] ?? 0)
  })

  test('out is the reverse of in', () => {
    const ins = flightEnds('in', 120, 40)
    const out = flightEnds('out', 120, 40)
    expect(out.from).toEqual(ins.to)
    expect(out.to).toEqual(ins.from)
  })

  test('clamps outside the range', () => {
    expect(flightBox(home, CHAT_ORB_BOX, 99)).toEqual(CHAT_ORB_BOX)
    expect(flightBox(home, CHAT_ORB_BOX, -3)).toEqual(home)
  })
})

describe('homeOrbBox', () => {
  test('is centred and agrees with homeSize', () => {
    const s = homeSize(120, 40)
    const box = homeOrbBox(120, 40)
    expect(box.left).toBe(Math.floor((120 - s.orbWidth) / 2))
    expect(box.top).toBe(3)
    expect(box.height).toBe(31)
  })
})

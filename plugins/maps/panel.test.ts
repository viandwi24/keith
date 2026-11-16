import { describe, expect, test } from 'bun:test'
import {
  arrival,
  averageSpeed,
  formatDistance,
  formatDuration,
  readAnswer,
  turnOf,
} from './web/panel.js'

describe('maps: route panel', () => {
  test('distances and durations read like a navigation app', () => {
    expect(formatDistance(57)).toBe('60 m')
    expect(formatDistance(5_140)).toBe('5.1 km')
    expect(formatDistance(49_300)).toBe('49 km')
    expect(formatDuration(42)).toBe('42 s')
    expect(formatDuration(370)).toBe('6 min')
    expect(formatDuration(6_720)).toBe('1 h 52 min')
    expect(formatDuration(7_200)).toBe('2 h')
  })

  test('arrival is the local time when leaving now, with the day past midnight', () => {
    const now = new Date(2026, 10, 16, 23, 30)
    expect(arrival(now, 20 * 60)).toBe('23:50')
    expect(arrival(now, 45 * 60)).toBe('00:15 +1d')
    expect(averageSpeed(49_000, 6_720)).toBe('26 km/h')
    expect(averageSpeed(1_000, 0)).toBe('—')
  })

  test('a step text gets a turn glyph', () => {
    expect(turnOf('Start on Jalan Tunjungan')).toBe('●')
    expect(turnOf('Turn left onto Jalan Basuki Rahmat')).toBe('↰')
    expect(turnOf('Turn right onto Jalan Pemuda')).toBe('↱')
    expect(turnOf('Keep left at the fork')).toBe('↖')
    expect(turnOf('At the roundabout take exit 2')).toBe('↻')
    expect(turnOf('Make a U-turn')).toBe('↶')
    expect(turnOf('Arrive at the destination')).toBe('◎')
    expect(turnOf('Continue onto Jalan Raya Darmo')).toBe('↑')
  })

  test('the route answer is read by hand: bad steps and points are dropped', () => {
    expect(readAnswer({ distanceM: 'far' })).toBeUndefined()
    expect(readAnswer(null)).toBeUndefined()
    const answer = readAnswer({
      distanceM: 5_100,
      durationS: 370,
      mode: 'car',
      provider: 'osrm',
      note: '',
      steps: [
        { text: 'Start', distanceM: 120, at: [-7.26, 112.74] },
        { text: 'Turn left', at: ['x', 1] },
        { distanceM: 3 },
      ],
      geometry: [[-7.26, 112.74], [1], [-7.27, 112.75]],
    })
    expect(answer).toEqual({
      distanceM: 5_100,
      durationS: 370,
      mode: 'car',
      provider: 'osrm',
      steps: [{ text: 'Start', distanceM: 120, at: [-7.26, 112.74] }, { text: 'Turn left' }],
      line: [
        [-7.26, 112.74],
        [-7.27, 112.75],
      ],
    })
  })
})

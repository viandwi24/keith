import { describe, expect, test } from 'bun:test'
import {
  CALL_DETAIL,
  CALL_ERR,
  CALL_OK,
  RAW,
  SESSION,
  SESSION_DETAIL,
  T0,
} from './logs-fixtures.ts'
import {
  bodyNote,
  callLines,
  count,
  GENERATION_HEADER,
  generationRow,
  latencyOf,
  rangeOf,
  rawLines,
  sessionLines,
  sessionRow,
  shortId,
  spanOf,
  throughputOf,
  usd,
} from './logs-format.ts'

const texts = (lines: readonly { text: string }[]) => lines.map((l) => l.text)

describe('figures as words', () => {
  test('a long id is cut in the middle and keeps its start and its end', () => {
    const id = 'front:9f2c41aa-0000-7000-8000-abcdefabcdef'
    expect(shortId('front:ana:g0')).toBe('front:ana:g0')
    expect(shortId(id)).toHaveLength(24)
    expect(shortId(id).startsWith('front:9f2c41aa')).toBe(true)
    expect(shortId(id).endsWith('abcdef')).toBe(true)
    expect(shortId(id)).toContain('…')
  })

  test('money: micro-dollars as dollars, a dash for an unpriced call', () => {
    expect(usd(null)).toBe('—')
    expect(usd(45_600)).toBe('$0.0456')
    expect(usd(2_500_000)).toBe('$2.50')
  })

  test('token counts and spans', () => {
    expect([count(840), count(1200), count(12_000), count(1_300_000)]).toEqual([
      '840',
      '1.2k',
      '12k',
      '1.3M',
    ])
    expect([spanOf(192_000), spanOf(42_000)]).toEqual(['3m 12s', '42s'])
    expect([latencyOf(842), latencyOf(1840)]).toEqual(['842 ms', '1.84 s'])
  })

  test('throughput is output tokens per second; nothing to divide gives none', () => {
    expect(throughputOf(340, 1840)).toBe('185 tok/s')
    expect(throughputOf(0, 1840)).toBeNull()
    expect(throughputOf(340, 0)).toBeNull()
  })

  test('the range of a session: one day shows the end time only', () => {
    expect(rangeOf(Date.UTC(2026, 10, 11, 14, 2), Date.UTC(2026, 10, 11, 14, 20))).toBe(
      '11-11 14:02-14:20',
    )
    expect(rangeOf(Date.UTC(2026, 10, 10, 14, 2), Date.UTC(2026, 10, 11, 9, 0))).toBe(
      '11-10 14:02-11-11 09:00',
    )
  })

  test('a body that is off or purged says so in words', () => {
    expect(bodyNote('stored')).toBeNull()
    expect(bodyNote('off')).toContain('figures only')
    expect(bodyNote('purged')).toContain('purged')
  })
})

describe('table rows', () => {
  test('a session row has one cell per column; the cost is last', () => {
    const row = sessionRow(SESSION)
    expect(row.id).toBe('front:ana:g0')
    expect(row.cells).toHaveLength(7)
    expect(row.cells.slice(1, 5)).toEqual([
      'Front',
      'front:ana:g0',
      'claude-sonnet-4.5',
      'openrouter',
    ])
    expect(row.cells.at(-1)).toBe('$0.0456')
  })

  test('the cache cell: the hit share and the cached tokens, marked ↓ first when low; a dash when unreported', () => {
    const cached = { ...CALL_OK, cacheRead: 900 }
    expect(generationRow(cached).cells[3]).toBe('75% · 900')
    expect(generationRow(cached, true).cells[3]).toBe('↓ 75% · 900')
    expect(generationRow(CALL_OK).cells[3]).toBe('—')
    expect(GENERATION_HEADER).toContain('cache hit')
  })

  test('a generation row carries its status as a glyph and a word', () => {
    expect(generationRow(CALL_OK).cells.at(-1)).toBe('● ok')
    expect(generationRow(CALL_ERR).cells.at(-1)).toBe('✕ error')
    expect(generationRow(CALL_ERR).cells[2]).toBe('300 → 0')
  })
})

describe('the session overview', () => {
  test('requests, cost, models, span, app and the start', () => {
    const lines = texts(sessionLines(SESSION_DETAIL))
    expect(lines[0]).toBe('requests  2')
    expect(lines[1]).toBe('cost  $0.0456')
    expect(lines[2]).toBe('models  claude-sonnet-4.5, gpt-4.1-mini')
    expect(lines[3]).toBe('duration  3m 12s')
    expect(lines[4]).toBe('app  Front')
    expect(lines[5]).toBe('started  2026-11-11 14:02 UTC')
  })

  test('input tokens, the cache hit of the session, and no legend while no call is low', () => {
    const lines = texts(
      sessionLines({ ...SESSION_DETAIL, generations: [{ ...CALL_OK, cacheRead: 900 }] }),
    )
    expect(lines.slice(6)).toEqual(['input  1.2k', 'cache hit  75% · 900 cached'])
  })

  test('a later call under a low cache hit is in the legend, with the words low cache hit', () => {
    const first = { ...CALL_OK, cacheRead: 900 }
    const low = { ...CALL_ERR, cacheRead: 0 }
    const lines = texts(sessionLines({ ...SESSION_DETAIL, generations: [first, low] }))
    expect(lines.some((l) => l.includes('low cache hit'))).toBe(true)
  })

  test('a session that lists fewer generations than it made says so', () => {
    const lines = texts(sessionLines({ ...SESSION_DETAIL, more: true }))
    expect(lines[0]).toBe('requests  2 · first 2 listed')
  })
})

describe('the generation level', () => {
  test('the figures: status and finish, latency with the first chunk, throughput, tokens, cost', () => {
    const lines = texts(callLines(CALL_DETAIL))
    expect(lines).toContain('status  ● ok · finish stop')
    expect(lines).toContain('latency  1.84 s · first chunk 410 ms')
    expect(lines).toContain('streaming  yes')
    expect(lines).toContain('speed  185 tok/s')
    expect(lines).toContain('tokens  in 1.2k · out 340')
    expect(lines).toContain('cost  $0.0042 (provider)')
    expect(lines).toContain('provider  openrouter via anthropic')
    expect(lines).toContain('fallbacks  none')
  })

  test('the messages sent as role and text blocks, then the tool calls and the response', () => {
    const lines = texts(callLines(CALL_DETAIL))
    const at = (t: string) => lines.indexOf(t)
    expect(at('system')).toBeGreaterThan(0)
    expect(lines).toContain('  You are Keith.')
    expect(at('user')).toBeGreaterThan(at('system'))
    expect(lines.some((l) => l.startsWith('  motor_remote  {"node":"laptop-e"}'))).toBe(true)
    expect(at('response')).toBeGreaterThan(at('tool calls'))
    expect(lines).toContain('  Checking the disk now.')
  })

  test('a failed call names its error in the danger tone, with no speed', () => {
    const detail = { ...CALL_DETAIL, call: CALL_ERR, toolCalls: [] }
    const lines = callLines(detail)
    const error = lines.find((l) => l.text.startsWith('error  '))
    expect(error?.text).toBe('error  TimeoutError: the provider did not answer')
    expect(error?.tone).toBe('danger')
    expect(texts(lines)).toContain('speed  —')
    expect(texts(lines)).toContain('cost  unknown')
  })

  test('a purged body says so in the bodies line and shows no message', () => {
    const detail = {
      ...CALL_DETAIL,
      call: { ...CALL_OK, bodyState: 'purged' as const },
      messages: [],
      outputText: '',
    }
    const lines = texts(callLines(detail))
    expect(lines.find((l) => l.startsWith('bodies  '))).toContain('figures only')
    expect(lines).toContain('  no messages stored')
    expect(lines).toContain('  no text (the model only called tools)')
  })

  test('a long message is cut to its first lines with a count of the rest', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    const lines = texts(callLines({ ...CALL_DETAIL, messages: [{ role: 'user', text }] }))
    expect(lines).toContain('  line 12')
    expect(lines).not.toContain('  line 13')
    expect(lines).toContain('  … +8 more lines')
  })
})

describe('the raw level', () => {
  test('the request then the response, pretty printed; a cut body is flagged at the top', () => {
    const lines = texts(rawLines(RAW))
    expect(lines[0]).toBe('truncated: the body was cut to the size the wire carries')
    const request = lines.indexOf('request')
    const response = lines.indexOf('response')
    expect(request).toBeGreaterThan(0)
    expect(response).toBeGreaterThan(request)
    expect(lines).toContain('  "model": "claude-sonnet-4.5",')
    expect(lines.indexOf('  "model": "claude-sonnet-4.5",')).toBeLessThan(response)
  })

  test('a body the cap cut is not valid JSON any more: it is shown as it is', () => {
    const cut = { ...RAW, truncated: true, request: '{"model":"claude-son', response: null }
    const lines = texts(rawLines(cut))
    expect(lines).toContain('{"model":"claude-son')
    expect(lines).toContain('  no stored body')
  })

  test('a body that is not stored says why, before any JSON', () => {
    const lines = texts(rawLines({ ...RAW, bodyState: 'off', request: null, response: null }))
    expect(lines[0]).toContain('bodies were off')
    expect(lines.filter((l) => l === '  no stored body')).toHaveLength(2)
  })
})

describe('no content in a list', () => {
  test('the session row holds ids and figures only, never a message', () => {
    expect(JSON.stringify(sessionRow(SESSION))).not.toContain('disk')
  })

  test('the generation level starts with its status, then the start time', () => {
    expect(callLines(CALL_DETAIL)[1]?.text).toBe('started  2026-11-11 14:02 UTC')
    expect(T0).toBe(Date.UTC(2026, 10, 11, 14, 2, 11))
  })
})

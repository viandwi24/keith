import { describe, expect, test } from 'bun:test'
import { logsHref, parentRoute, parseLogsRoute } from './logs-path.ts'

describe('parseLogsRoute', () => {
  test('each depth is a level', () => {
    expect(parseLogsRoute('')).toEqual({ level: 'sessions' })
    expect(parseLogsRoute(undefined)).toEqual({ level: 'sessions' })
    expect(parseLogsRoute('front%3Aana%3Ag0')).toEqual({
      level: 'session',
      sessionId: 'front:ana:g0',
    })
    expect(parseLogsRoute('s/c')).toEqual({ level: 'call', sessionId: 's', callId: 'c' })
    expect(parseLogsRoute('s/c/raw')).toEqual({ level: 'raw', sessionId: 's', callId: 'c' })
  })

  test('anything else is invalid', () => {
    expect(parseLogsRoute('s/c/other')).toEqual({ level: 'invalid' })
    expect(parseLogsRoute('a/b/c/d')).toEqual({ level: 'invalid' })
    expect(parseLogsRoute('%E0%A4%A')).toEqual({ level: 'invalid' })
  })
})

describe('logsHref', () => {
  test('round-trips with the parser, ids encoded', () => {
    const route = { level: 'call', sessionId: 'front:ana/g0', callId: 'c 1' } as const
    const href = logsHref('/app', route)
    expect(href).toBe('/app/manage/logs/front%3Aana%2Fg0/c%201')
    expect(parseLogsRoute(href.replace('/app/manage/logs/', ''))).toEqual(route)
  })

  test('the sessions list is the root', () => {
    expect(logsHref('/app', { level: 'sessions' })).toBe('/app/manage/logs')
  })
})

test('parentRoute goes up one level', () => {
  expect(parentRoute({ level: 'raw', sessionId: 's', callId: 'c' })).toEqual({
    level: 'call',
    sessionId: 's',
    callId: 'c',
  })
  expect(parentRoute({ level: 'session', sessionId: 's' })).toEqual({ level: 'sessions' })
  expect(parentRoute({ level: 'sessions' })).toBeUndefined()
})

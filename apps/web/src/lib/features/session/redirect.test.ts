import { describe, expect, test } from 'bun:test'
import { afterSignIn, loginUrl, safeNext } from './redirect.ts'

describe('safeNext', () => {
  test('keeps a path inside the app, with its query', () => {
    expect(safeNext('/app', '/app/chat?x=1')).toBe('/app/chat?x=1')
    expect(safeNext('/app', '/app/')).toBe('/app/')
  })
  test('refuses what could leave the app or loop', () => {
    for (const bad of [
      undefined,
      null,
      '',
      '/other',
      '//evil.example/app/x',
      '/app//evil.example',
      'https://evil.example/app/x',
      '/app/x\\y',
      '/app/login',
      '/app/login?next=/app/chat',
    ])
      expect(safeNext('/app', bad)).toBeUndefined()
  })
})

describe('loginUrl and afterSignIn', () => {
  test('carries the wanted path; Home and the login screen carry none', () => {
    expect(loginUrl('/app', '/app/tasks')).toBe('/app/login?next=%2Fapp%2Ftasks')
    expect(loginUrl('/app', '/app/')).toBe('/app/login')
    expect(loginUrl('/app', '/app/login')).toBe('/app/login')
    expect(loginUrl('/app', '//evil.example')).toBe('/app/login')
  })
  test('goes to the wanted path, else Home', () => {
    expect(afterSignIn('/app', '/app/tasks')).toBe('/app/tasks')
    expect(afterSignIn('/app', 'https://evil.example')).toBe('/app/')
    expect(afterSignIn('/app', null)).toBe('/app/')
  })
})

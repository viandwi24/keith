import { describe, expect, test } from 'bun:test'
import { gateAction, isGuestPath, statusOfFailure } from './gate.ts'

describe('gateAction', () => {
  test('waits while loading', () => {
    expect(gateAction('loading', true)).toBe('wait')
    expect(gateAction('loading', false)).toBe('wait')
  })
  test('signed out: the login screen stays, everything else goes to it', () => {
    expect(gateAction('signed-out', true)).toBe('stay')
    expect(gateAction('signed-out', false)).toBe('to-login')
  })
  test('signed in: the shell stays, the login screen goes to the app', () => {
    expect(gateAction('signed-in', false)).toBe('stay')
    expect(gateAction('signed-in', true)).toBe('to-app')
  })
  test('an error keeps the person where they are', () => {
    expect(gateAction('error', false)).toBe('stay')
    expect(gateAction('error', true)).toBe('stay')
  })
})

describe('statusOfFailure', () => {
  test('a 401 or UNAUTHORIZED is signed out; anything else is an error', () => {
    expect(statusOfFailure({ status: 401 })).toBe('signed-out')
    expect(statusOfFailure({ code: 'UNAUTHORIZED' })).toBe('signed-out')
    expect(statusOfFailure({ status: 503 })).toBe('error')
    expect(statusOfFailure(new Error('network'))).toBe('error')
    expect(statusOfFailure(undefined)).toBe('error')
  })
})

describe('isGuestPath', () => {
  test('only the guest page is open without a session', () => {
    expect(isGuestPath('/app', '/app/guest')).toBe(true)
    expect(isGuestPath('/app', '/app/guest/')).toBe(true)
    expect(isGuestPath('/app', '/app/guestbook')).toBe(false)
    expect(isGuestPath('/app', '/app/guest/x')).toBe(false)
    expect(isGuestPath('/app', '/app/chat')).toBe(false)
  })
})

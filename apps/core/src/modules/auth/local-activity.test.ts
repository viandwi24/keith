import { describe, expect, test } from 'bun:test'
import { isUserActivity } from './local-activity.ts'

describe('which socket requests count as the owner being there', () => {
  test('a chat send, an approval and an admin change count', () => {
    expect(isUserActivity('POST', '/sessions/front:owner/messages')).toBe(true)
    expect(isUserActivity('POST', '/attention/abc/answer')).toBe(true)
    expect(isUserActivity('POST', '/rpc/admin/people/add')).toBe(true)
    expect(isUserActivity('POST', '/rpc/budget/set')).toBe(true)
    expect(isUserActivity('POST', '/rpc/tasks/stop')).toBe(true)
  })

  test('what a client does by itself does not', () => {
    expect(isUserActivity('GET', '/health')).toBe(false)
    expect(isUserActivity('GET', '/activity/stream')).toBe(false)
    expect(isUserActivity('GET', '/attention')).toBe(false)
    expect(isUserActivity('GET', '/sessions/front:owner')).toBe(false)
    expect(isUserActivity('POST', '/rpc/tasks/list')).toBe(false)
    expect(isUserActivity('POST', '/rpc/budget/get')).toBe(false)
    expect(isUserActivity('POST', '/rpc/auth/whoami')).toBe(false)
    expect(isUserActivity('POST', '/rpc/health/get')).toBe(false)
    expect(isUserActivity('POST', '/rpc/admin/audit/list')).toBe(false)
  })

  test('the sign-in routes and node traffic do not', () => {
    expect(isUserActivity('POST', '/auth/identify')).toBe(false)
    expect(isUserActivity('POST', '/auth/local/unlock')).toBe(false)
    expect(isUserActivity('POST', '/nodes/join')).toBe(false)
    expect(isUserActivity('GET', '/nodes/ws')).toBe(false)
  })
})

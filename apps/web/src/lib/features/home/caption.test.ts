import { describe, expect, test } from 'bun:test'
import { captionOf } from './caption.ts'

const calm = { link: 'live', approvals: 0, dreaming: false, busy: false } as const

describe('captionOf', () => {
  test('nothing when all is calm', () => {
    expect(captionOf(calm)).toBeUndefined()
  })
  test('signed out and core down are danger alerts', () => {
    expect(captionOf({ ...calm, link: 'logged-out' })?.rows[0]).toMatchObject({ tone: 'danger' })
    expect(captionOf({ ...calm, link: 'logged-out' })?.path).toBe('/login')
    expect(captionOf({ ...calm, link: 'disconnected' })?.rows[0]?.text).toContain(
      'Cannot reach the core',
    )
  })
  test('approvals waiting lead to the Inbox, with a plural', () => {
    expect(captionOf({ ...calm, approvals: 1 })).toMatchObject({ path: '/inbox' })
    expect(captionOf({ ...calm, approvals: 1 })?.rows[0]?.text).toContain('1 approval waiting')
    expect(captionOf({ ...calm, approvals: 3 })?.rows[0]?.text).toContain('3 approvals waiting')
  })
  test('dreaming shows only when no alert holds the slot and no turn runs', () => {
    expect(captionOf({ ...calm, dreaming: true })?.rows[0]?.text).toBe('dreaming…')
    expect(captionOf({ ...calm, dreaming: true, busy: true })).toBeUndefined()
    expect(captionOf({ ...calm, dreaming: true, approvals: 1 })?.rows[0]?.tone).toBe('warning')
  })
  test('the room banner takes the slot after the alerts, before dreaming, and links to the room', () => {
    const room = {
      roomId: 'r 1',
      tone: 'accent',
      text: '● Room "Planning" · Ana, Keith · /room',
    } as const
    expect(captionOf({ ...calm, room })).toEqual({
      rows: [{ text: room.text, tone: 'accent' }],
      path: '/rooms/r%201',
    })
    expect(captionOf({ ...calm, room, dreaming: true })?.rows[0]?.text).toBe(room.text)
    expect(captionOf({ ...calm, room, approvals: 1 })?.path).toBe('/inbox')
    expect(captionOf({ ...calm, room, link: 'disconnected' })?.rows[0]?.tone).toBe('danger')
    expect(captionOf({ ...calm, room, busy: true })).toBeUndefined()
    expect(captionOf({ ...calm, room: { ...room, tone: 'muted' } })?.rows[0]?.tone).toBe('muted')
  })
})

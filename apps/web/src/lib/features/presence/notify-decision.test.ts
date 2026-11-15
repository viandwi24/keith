import { describe, expect, test } from 'bun:test'
import {
  canToggle,
  decideNotify,
  NOTIFY_KEY,
  notificationsLabel,
  readOptIn,
  shouldTouch,
  viewPath,
  writeOptIn,
} from './notify-decision.ts'

const base = { name: 'reminder', hidden: false, permission: 'granted', optedIn: true } as const

describe('decideNotify', () => {
  test('a visible tab gets the toast only', () => {
    expect(decideNotify({ ...base, text: 'Tea is ready' })).toEqual({
      toast: 'Tea is ready',
      system: undefined,
    })
  })
  test('a hidden tab also gets a system notification when opted in and allowed', () => {
    expect(decideNotify({ ...base, text: 'Tea is ready', hidden: true }).system).toEqual({
      title: 'Keith',
      body: 'Tea is ready',
    })
  })
  test('no system notification without the opt-in, the permission or a hidden tab', () => {
    expect(decideNotify({ ...base, hidden: true, optedIn: false }).system).toBeUndefined()
    expect(decideNotify({ ...base, hidden: true, permission: 'denied' }).system).toBeUndefined()
    expect(decideNotify({ ...base, hidden: true, permission: 'default' }).system).toBeUndefined()
    expect(
      decideNotify({ ...base, hidden: true, permission: 'unsupported' }).system,
    ).toBeUndefined()
  })
  test('the name stands in for a missing text; long text is clipped', () => {
    expect(decideNotify({ ...base }).toast).toBe('reminder')
    expect(decideNotify({ ...base, name: '', text: '  ' }).toast).toBe(
      'Keith has something for you',
    )
    const long = decideNotify({ ...base, text: 'x'.repeat(500) }).toast
    expect(long).toHaveLength(200)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('the opt-in', () => {
  const memory = () => {
    const map = new Map<string, string>()
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      map,
    }
  }
  test('off by default, remembered, removed, and a blocked storage never throws', () => {
    const s = memory()
    expect(readOptIn(s)).toBe(false)
    writeOptIn(true, s)
    expect(s.map.get(NOTIFY_KEY)).toBe('on')
    expect(readOptIn(s)).toBe(true)
    writeOptIn(false, s)
    expect(readOptIn(s)).toBe(false)
    const blocked = {
      getItem: (): string | null => {
        throw new Error('x')
      },
      setItem: (): void => {
        throw new Error('x')
      },
      removeItem: (): void => {
        throw new Error('x')
      },
    }
    expect(readOptIn(blocked)).toBe(false)
    expect(() => writeOptIn(true, blocked)).not.toThrow()
  })
  test('the label says what the click will do; a blocked browser cannot toggle', () => {
    expect(notificationsLabel(false, 'default')).toBe('Turn on desktop notifications')
    expect(notificationsLabel(true, 'granted')).toBe('Turn off desktop notifications')
    expect(notificationsLabel(true, 'denied')).toContain('blocked')
    expect(notificationsLabel(false, 'unsupported')).toContain('not available')
    expect(canToggle('default')).toBe(true)
    expect(canToggle('denied')).toBe(false)
    expect(canToggle('unsupported')).toBe(false)
  })
})

describe('open.view and touches', () => {
  test('the views the web can open map to routes (a plugin view to Apps); unknown ones do not', () => {
    expect(viewPath('tasks')).toBe('/tasks')
    expect(viewPath('protocols')).toBe('/manage')
    expect(viewPath('room:abc123')).toBe('/rooms/abc123')
    expect(viewPath('plugin:notes:list')).toBe('/apps/notes/list')
    expect(viewPath('plugin:no tes:list')).toBeUndefined()
    expect(viewPath('nonsense')).toBeUndefined()
  })
  test('touches are throttled', () => {
    expect(shouldTouch(0, 999)).toBe(false)
    expect(shouldTouch(0, 1000)).toBe(true)
    expect(shouldTouch(5000, 5500, 100)).toBe(true)
  })
})

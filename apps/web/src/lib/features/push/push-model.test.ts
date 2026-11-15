import { describe, expect, test } from 'bun:test'
import {
  AVAILABILITY_TEXT,
  availabilityOf,
  deviceRowsOf,
  failureText,
  type PushPlatform,
  toggleEnabled,
  toggleLabel,
  toggleStep,
} from './push-model.ts'

const platform = (over: Partial<PushPlatform> = {}): PushPlatform => ({
  secureContext: true,
  serviceWorker: true,
  pushManager: true,
  notification: true,
  ios: false,
  standalone: false,
  permission: 'default',
  ...over,
})

describe('availability', () => {
  test('a secure browser with the APIs is ready, also when already allowed', () => {
    expect(availabilityOf(platform())).toBe('ready')
    expect(availabilityOf(platform({ permission: 'granted' }))).toBe('ready')
  })
  test('plain HTTP comes first, then the iOS install, then missing APIs, then a block', () => {
    expect(
      availabilityOf(platform({ secureContext: false, ios: true, serviceWorker: false })),
    ).toBe('insecure')
    expect(availabilityOf(platform({ ios: true, standalone: false, pushManager: false }))).toBe(
      'needs-install',
    )
    expect(availabilityOf(platform({ ios: true, standalone: true }))).toBe('ready')
    expect(availabilityOf(platform({ pushManager: false }))).toBe('unsupported')
    expect(availabilityOf(platform({ notification: false }))).toBe('unsupported')
    expect(availabilityOf(platform({ permission: 'denied' }))).toBe('blocked')
  })
  test('every reason has its words, and the iOS one names the version and the Home Screen', () => {
    for (const k of ['insecure', 'needs-install', 'unsupported', 'blocked'] as const)
      expect(AVAILABILITY_TEXT[k].length).toBeGreaterThan(20)
    expect(AVAILABILITY_TEXT['needs-install']).toContain('16.4')
    expect(AVAILABILITY_TEXT['needs-install']).toContain('Home Screen')
    expect(AVAILABILITY_TEXT.insecure).toContain('HTTPS')
  })
})

describe('the toggle state machine', () => {
  const ready = { availability: 'ready', subscribed: false, busy: false } as const
  test('off and ready subscribes; on unsubscribes', () => {
    expect(toggleStep(ready)).toBe('subscribe')
    expect(toggleStep({ ...ready, subscribed: true })).toBe('unsubscribe')
  })
  test('turning off is possible even when the browser is blocked now; turning on is not', () => {
    expect(toggleStep({ availability: 'blocked', subscribed: true, busy: false })).toBe(
      'unsubscribe',
    )
    for (const availability of ['insecure', 'needs-install', 'unsupported', 'blocked'] as const) {
      expect(toggleStep({ availability, subscribed: false, busy: false })).toBe('none')
      expect(toggleEnabled({ availability, subscribed: false, busy: false })).toBe(false)
    }
  })
  test('nothing happens while a step runs', () => {
    expect(toggleStep({ ...ready, busy: true })).toBe('none')
    expect(toggleStep({ ...ready, subscribed: true, busy: true })).toBe('none')
    expect(toggleLabel({ ...ready, busy: true })).toBe('Working…')
  })
  test('labels', () => {
    expect(toggleLabel(ready)).toBe('Turn on notifications on this device')
    expect(toggleLabel({ ...ready, subscribed: true })).toBe(
      'Turn off notifications on this device',
    )
    expect(toggleLabel({ ...ready, availability: 'insecure' })).toBe(
      'Notifications are not available here',
    )
  })
})

describe('failures and devices', () => {
  test('a failure is one sentence by its name', () => {
    expect(failureText(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).toBe(
      'Notifications were not allowed.',
    )
    expect(failureText(Object.assign(new Error('x'), { name: 'AbortError' }))).toContain(
      'push service',
    )
    expect(failureText(new Error('boom'))).toBe('Could not turn on notifications: boom')
  })
  test('device rows: this browser first, health in words, a failing one flagged', () => {
    const now = 10 * 3_600_000
    const rows = deviceRowsOf(
      [
        {
          id: 'a',
          clientId: 'c1',
          label: 'Firefox (web)',
          createdAt: now - 3 * 86_400_000,
          lastSuccessAt: null,
          failures: 0,
        },
        {
          id: 'b',
          clientId: 'mine',
          label: 'Chrome (web)',
          createdAt: now - 60_000,
          lastSuccessAt: now - 5 * 60_000,
          failures: 0,
        },
        { id: 'c', clientId: null, label: '', createdAt: now, lastSuccessAt: null, failures: 2 },
      ],
      'mine',
      now,
    )
    expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(rows[0]).toMatchObject({
      here: true,
      added: 'added 1 min ago',
      health: 'last message 5 min ago',
      warn: false,
    })
    expect(rows[1]).toMatchObject({
      here: false,
      added: 'added 3 days ago',
      health: 'no message yet',
    })
    expect(rows[2]).toMatchObject({
      label: 'Unnamed browser',
      health: '2 failed sends in a row',
      warn: true,
    })
  })
})

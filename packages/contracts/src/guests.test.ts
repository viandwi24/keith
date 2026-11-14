import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_GUEST_SETTINGS,
  GUEST_LIMITS,
  GuestSessionAuditSchema,
  GuestSettingsPatchSchema,
  GuestSettingsSchema,
  GuestStatusSchema,
} from './guests.ts'
import { ModelRoleSchema, ModelRolesSchema } from './models.ts'

const audit = {
  guestId: 'k3j9x0',
  zone: 'lan',
  ipHash: 'a1b2c3d4e5f6',
  clientKind: 'tui',
  startedAt: 1_000,
  endedAt: 2_000,
  reason: 'idle',
  turns: 3,
  inputTokens: 120,
  outputTokens: 80,
  costUsd: 0.002,
  tools: { notes_public_get: 1 },
  refusals: { 'input-too-long': 1 },
}

describe('guest settings', () => {
  test('the defaults are off, lan only and within the ADR caps', () => {
    expect(GuestSettingsSchema.safeParse(DEFAULT_GUEST_SETTINGS).success).toBe(true)
    expect(DEFAULT_GUEST_SETTINGS).toMatchObject({
      enabled: false,
      zones: ['lan'],
      dailyUsd: 0.5,
      monthlyUsd: 5,
      maxConcurrent: 3,
      maxTurns: 20,
      sessionsPerIpPerWindow: 5,
      idleMs: 1_800_000,
      absoluteMs: 7_200_000,
    })
    expect(GUEST_LIMITS).toMatchObject({ maxInputChars: 2048, maxSteps: 3, maxOutputTokens: 800 })
  })

  test('bounds and unknown keys are refused', () => {
    const bad = (over: Record<string, unknown>) =>
      GuestSettingsSchema.safeParse({ ...DEFAULT_GUEST_SETTINGS, ...over }).success
    expect(bad({ dailyUsd: 0 })).toBe(false)
    expect(bad({ maxConcurrent: 0 })).toBe(false)
    expect(bad({ zones: ['moon'] })).toBe(false)
    expect(bad({ idleMs: 10 })).toBe(false)
    expect(bad({ extra: 1 })).toBe(false)
    expect(bad({ port: 70_000 })).toBe(false)
  })

  test('a patch names some fields only', () => {
    expect(GuestSettingsPatchSchema.safeParse({ enabled: true }).success).toBe(true)
    expect(GuestSettingsPatchSchema.safeParse({}).success).toBe(true)
    expect(GuestSettingsPatchSchema.safeParse({ nope: 1 }).success).toBe(false)
  })
})

describe('guest status and audit row', () => {
  test('status carries the model, the blocking reason and both scopes', () => {
    const scope = { scope: 'guests', limitUsd: 5, spentUsd: 0, remainingUsd: 5 }
    expect(
      GuestStatusSchema.safeParse({
        settings: DEFAULT_GUEST_SETTINGS,
        killed: false,
        model: { ref: null, priced: false },
        active: 0,
        blocked: 'disabled',
        budget: { monthly: scope, daily: scope, ownerRemaining: 0.9 },
      }).success,
    ).toBe(true)
  })

  test('the aggregate row is strict: no text, raw IP or user agent can be added', () => {
    expect(GuestSessionAuditSchema.safeParse(audit).success).toBe(true)
    for (const extra of ['ip', 'userAgent', 'text', 'title', 'input']) {
      expect(GuestSessionAuditSchema.safeParse({ ...audit, [extra]: 'x' }).success).toBe(false)
    }
    expect(GuestSessionAuditSchema.safeParse({ ...audit, reason: 'bored' }).success).toBe(false)
  })
})

describe('the guest model role', () => {
  test('is a role, and the roles object may omit it (older cores) or hold null', () => {
    expect(ModelRoleSchema.safeParse('guest').success).toBe(true)
    expect(ModelRolesSchema.safeParse({ front: null, cortex: null }).success).toBe(true)
    expect(ModelRolesSchema.safeParse({ front: null, cortex: null, guest: null }).success).toBe(
      true,
    )
    expect(ModelRolesSchema.safeParse({ front: null, cortex: null, guest: 'or:m' }).success).toBe(
      true,
    )
  })
})

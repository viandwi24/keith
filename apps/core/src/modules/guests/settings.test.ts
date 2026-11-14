import { describe, expect, test } from 'bun:test'
import { DEFAULT_GUEST_SETTINGS } from '@keith/contracts'
import { migrateDatabase, openDatabase, settingsRepo } from '@keith/db'
import { createGuestSettings, GuestError } from './settings.ts'

function fresh() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const settings = settingsRepo(sqlite)
  return { settings, store: createGuestSettings(settings) }
}

describe('guest settings store', () => {
  test('reads the defaults when nothing is stored; guests start off', () => {
    const { store } = fresh()
    expect(store.get()).toEqual(DEFAULT_GUEST_SETTINGS)
    expect(store.get().enabled).toBe(false)
    expect(store.killed()).toBe(false)
  })

  test('a patch changes the named keys only and survives a new store over the same table', () => {
    const { settings, store } = fresh()
    store.set({ maxTurns: 7, zones: ['lan', 'tailscale'] })
    expect(createGuestSettings(settings).get()).toEqual({
      ...DEFAULT_GUEST_SETTINGS,
      maxTurns: 7,
      zones: ['lan', 'tailscale'],
    })
    expect(settings.get('guests.dailyUsd')).toBeUndefined()
  })

  test('an invalid stored value reads as its default instead of throwing', () => {
    const { settings, store } = fresh()
    settings.set('guests.maxConcurrent', 'lots')
    settings.set('guests.dailyUsd', -4)
    expect(store.get().maxConcurrent).toBe(DEFAULT_GUEST_SETTINGS.maxConcurrent)
    expect(store.get().dailyUsd).toBe(DEFAULT_GUEST_SETTINGS.dailyUsd)
  })

  test('idle longer than absolute and a public zone without https are refused and store nothing', () => {
    const { settings, store } = fresh()
    expect(() => store.set({ idleMs: 3_600_000, absoluteMs: 600_000 })).toThrow(GuestError)
    expect(() => store.set({ zones: ['public'] })).toThrow(/https/)
    expect(() => store.set({ zones: ['public'] }, { publicUrl: 'http://x.example' })).toThrow(
      GuestError,
    )
    expect(() => store.set({ zones: ['public'] }, { publicUrl: 'https://x.example' })).not.toThrow()
    expect(settings.get('guests.idleMs')).toBeUndefined()
  })

  test('the kill switch is stored apart from the settings', () => {
    const { store } = fresh()
    store.setKilled(true)
    expect(store.killed()).toBe(true)
    expect(store.get()).toEqual(DEFAULT_GUEST_SETTINGS)
  })
})

describe('the trusted proxy setting (P24.5.4, ADR-0027 §21)', () => {
  test('a trusted proxy needs at least one address, and every address is an IP or a CIDR', () => {
    const { store } = fresh()
    expect(store.get()).toMatchObject({ trustedProxy: 'none', proxyAddrs: [] })
    expect(() => store.set({ trustedProxy: 'x-forwarded-for' })).toThrow(GuestError)
    expect(() => store.set({ trustedProxy: 'cloudflare', proxyAddrs: ['not an address'] })).toThrow(
      /not an IP address or a CIDR/,
    )
    expect(store.get().trustedProxy).toBe('none')
    expect(
      store.set({ trustedProxy: 'x-forwarded-for', proxyAddrs: ['127.0.0.1', '10.0.0.0/8'] }),
    ).toMatchObject({ trustedProxy: 'x-forwarded-for', proxyAddrs: ['127.0.0.1', '10.0.0.0/8'] })
  })

  test('the schema is strict: an unknown proxy kind is refused', async () => {
    const { GuestSettingsPatchSchema } = await import('@keith/contracts')
    expect(GuestSettingsPatchSchema.safeParse({ trustedProxy: 'anything' }).success).toBe(false)
    expect(
      GuestSettingsPatchSchema.safeParse({ proxyAddrs: Array(17).fill('10.0.0.1') }).success,
    ).toBe(false)
  })
})

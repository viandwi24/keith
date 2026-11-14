import {
  DEFAULT_GUEST_SETTINGS,
  type GuestSettings,
  type GuestSettingsPatch,
  GuestSettingsSchema,
} from '@keith/contracts'
import { isProxyAddr } from './proxy-addrs.ts'

/** What guest settings need of the settings repo (`SettingsRepo` satisfies it). */
export interface SettingsPort {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
}

/** An owner-facing refusal; `code` is the oRPC code the procedure maps it to. */
export class GuestError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'GuestError'
  }
}

export const guestKey = (name: keyof GuestSettings): string => `guests.${name}`
/** The kill switch (a boolean). Not part of `GuestSettings`: it is an action, not a tuning knob. */
export const KILLED_KEY = 'guests.killed'

export interface GuestSettingsStore {
  /** The settings now: each stored value that parses, else its default. Never throws. */
  get(): GuestSettings
  /** Merge `patch` (already schema-checked) and store it; returns the new settings. Throws `GuestError` on a bad mix. */
  set(patch: GuestSettingsPatch, rules?: { publicUrl?: string | null | undefined }): GuestSettings
  killed(): boolean
  setKilled(on: boolean): void
}

/** `guests.*` in the settings table, one key each; an invalid stored value reads as its default. */
export function createGuestSettings(settings: SettingsPort): GuestSettingsStore {
  const names = Object.keys(DEFAULT_GUEST_SETTINGS) as Array<keyof GuestSettings>
  const read = (): GuestSettings => {
    const out: Record<string, unknown> = { ...DEFAULT_GUEST_SETTINGS }
    for (const name of names) {
      const stored = settings.get<unknown>(guestKey(name))
      if (stored === undefined) continue
      const field = GuestSettingsSchema.shape[name].safeParse(stored)
      if (field.success) out[name] = field.data
    }
    const merged = out as unknown as GuestSettings
    // a stored pair that breaks the idle/absolute rule would make every session end at once: read both as default
    return merged.idleMs <= merged.absoluteMs
      ? merged
      : {
          ...merged,
          idleMs: DEFAULT_GUEST_SETTINGS.idleMs,
          absoluteMs: DEFAULT_GUEST_SETTINGS.absoluteMs,
        }
  }
  return {
    get: read,
    set(patch, rules = {}) {
      const next: GuestSettings = { ...read(), ...definedOnly(patch) }
      if (next.idleMs > next.absoluteMs)
        throw new GuestError('BAD_REQUEST', 'idleMs must not be longer than absoluteMs')
      if (next.trustedProxy !== 'none' && next.proxyAddrs.length === 0)
        throw new GuestError(
          'BAD_REQUEST',
          `trustedProxy ${next.trustedProxy} needs the proxy addresses (--proxy-addr)`,
        )
      const badAddr = next.proxyAddrs.find((a) => !isProxyAddr(a))
      if (badAddr !== undefined)
        throw new GuestError('BAD_REQUEST', `${badAddr} is not an IP address or a CIDR`)
      if (next.zones.includes('public') && !(rules.publicUrl ?? '').startsWith('https:'))
        throw new GuestError(
          'BAD_REQUEST',
          'the public zone needs an https: public URL (set one with `keith-core access`)',
        )
      for (const name of names) {
        if (patch[name] !== undefined) settings.set(guestKey(name), next[name])
      }
      return next
    },
    killed: () => settings.get<boolean>(KILLED_KEY) === true,
    setKilled: (on) => settings.set(KILLED_KEY, on),
  }
}

function definedOnly(patch: GuestSettingsPatch): Partial<GuestSettings> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<GuestSettings>
}

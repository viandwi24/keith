import { describe, expect, test } from 'bun:test'
import { webCryptoVault } from 'eharness/providers'
import { loadVapidKeys, pushSubject, VAPID_SETTING } from './keys.ts'

const memory = () => {
  const map = new Map<string, unknown>()
  return {
    map,
    get: <T>(key: string) => map.get(key) as T | undefined,
    set: (key: string, value: unknown) => void map.set(key, value),
  }
}
const vaultOf = (byte: number) => webCryptoVault(new Uint8Array(32).fill(byte))

describe('loadVapidKeys', () => {
  test('creates the pair once and seals the private key: no JWK in the stored value', async () => {
    const settings = memory()
    const first = await loadVapidKeys({ settings, vault: vaultOf(1), subject: 'mailto:a@b.co' })
    const stored = settings.map.get(VAPID_SETTING) as { publicKey: string; sealed: string }
    expect(stored.publicKey).toBe(first.publicKey)
    expect(JSON.stringify(stored)).not.toContain('"d"')
    expect(stored.sealed).not.toContain('kty')
    const again = await loadVapidKeys({ settings, vault: vaultOf(1), subject: 'mailto:a@b.co' })
    expect(again.publicKey).toBe(first.publicKey)
  })

  test('a pair this vault cannot open is replaced with a warning', async () => {
    const settings = memory()
    const first = await loadVapidKeys({ settings, vault: vaultOf(1), subject: 'mailto:a@b.co' })
    const warned: string[] = []
    const second = await loadVapidKeys({
      settings,
      vault: vaultOf(2),
      subject: 'mailto:a@b.co',
      warn: (m) => void warned.push(m),
    })
    expect(second.publicKey).not.toBe(first.publicKey)
    expect(warned).toHaveLength(1)
  })
})

describe('pushSubject', () => {
  test('the setting wins, then an https public url, then a placeholder', () => {
    expect(pushSubject({ pushSubject: 'mailto:me@x.io', publicUrl: 'https://k.example' })).toBe(
      'mailto:me@x.io',
    )
    expect(pushSubject({ publicUrl: 'https://k.example' })).toBe('https://k.example')
    expect(pushSubject({ publicUrl: 'http://10.0.0.2:7420' })).toMatch(/^mailto:/)
    expect(pushSubject({})).toMatch(/^mailto:/)
  })
})

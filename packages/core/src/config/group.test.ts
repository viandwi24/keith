import { describe, expect, test } from 'bun:test'
import { KeithError } from '@keith/sdk'
import { parseConfig } from './load.ts'

function caught(fn: () => unknown): KeithError {
  try {
    fn()
  } catch (error) {
    if (error instanceof KeithError) return error
    throw error
  }
  throw new Error('expected a throw')
}

describe('[mind.group], auth.inviteTtlHours and server.publicUrl (phase 5)', () => {
  test('an empty file gives every default, and no publicUrl', () => {
    const c = parseConfig({}, { env: {} })
    expect(c.mind.group).toEqual({ maxParticipants: 8, autoJoin: false, addressing: 'rules+utility' })
    expect(c.auth.inviteTtlHours).toBe(72)
    expect(c.server.publicUrl).toBeUndefined()
  })

  test('every key can be set', () => {
    const c = parseConfig(
      {
        server: { publicUrl: 'https://keith.example.net' },
        auth: { inviteTtlHours: 0.5 },
        mind: { group: { maxParticipants: 3, autoJoin: true, addressing: 'rules' } },
      },
      { env: {} },
    )
    expect(c.server.publicUrl).toBe('https://keith.example.net')
    expect(c.auth.inviteTtlHours).toBe(0.5)
    expect(c.mind.group).toEqual({ maxParticipants: 3, autoJoin: true, addressing: 'rules' })
  })

  test('KEITH__ overrides reach the new keys', () => {
    const c = parseConfig(
      {},
      {
        env: {
          KEITH__MIND__GROUP__MAXPARTICIPANTS: '4',
          KEITH__MIND__GROUP__AUTOJOIN: 'true',
          KEITH__AUTH__INVITETTLHOURS: '24',
        },
      },
    )
    expect(c.mind.group.maxParticipants).toBe(4)
    expect(c.mind.group.autoJoin).toBe(true)
    expect(c.auth.inviteTtlHours).toBe(24)
  })

  test('maxParticipants = 1 and inviteTtlHours = 0 are CONFIG_INVALID', () => {
    const max = caught(() => parseConfig({ mind: { group: { maxParticipants: 1 } } }, { env: {} }))
    expect(max.code).toBe('CONFIG_INVALID')
    expect(max.message).toContain('mind.group.maxParticipants')
    const ttl = caught(() => parseConfig({ auth: { inviteTtlHours: 0 } }, { env: {} }))
    expect(ttl.code).toBe('CONFIG_INVALID')
    expect(ttl.message).toContain('auth.inviteTtlHours')
  })

  test('a publicUrl that is not an http(s) URL is CONFIG_INVALID', () => {
    for (const publicUrl of ['keith.example.net', 'ftp://keith.example.net', 'https://', '']) {
      const error = caught(() => parseConfig({ server: { publicUrl } }, { env: {} }))
      expect(error.code).toBe('CONFIG_INVALID')
      expect(error.message).toContain('server.publicUrl')
    }
    const lan = parseConfig({ server: { publicUrl: 'http://192.168.1.5:4824' } }, { env: {} })
    expect(lan.server.publicUrl).toBe('http://192.168.1.5:4824')
  })

  test('an unknown addressing mode is CONFIG_INVALID', () => {
    const error = caught(() => parseConfig({ mind: { group: { addressing: 'utility' } } }, { env: {} }))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('mind.group.addressing')
  })
})

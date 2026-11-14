import { describe, expect, test } from 'bun:test'
import {
  detectEnvironment,
  deviceOf,
  type EnvironmentProbes,
  hostNameOf,
  hostOf,
  osOf,
} from './environment.ts'

// docs/decisions/0033 §2: the environment of a terminal is read from the machine with injectable probes. A probe that
// fails leaves its field out, the device is `unknown` when nothing tells, and detection never throws.

const MAC_LAPTOP: EnvironmentProbes = {
  hostname: () => 'ana-laptop.local',
  platform: () => 'darwin',
  release: () => '25.6.0',
  arch: () => 'arm64',
  macosVersion: async () => '16.0',
  batteryReport: async () => "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t88%",
  localHostName: async () => 'ana-laptop\n',
  computerName: async () => "Ana's MacBook",
  etcHostname: () => undefined,
  powerSupplies: () => undefined,
  timeZone: () => 'Asia/Jakarta',
  locale: () => 'id-ID',
}

const none = (): undefined => undefined

describe('osOf and hostOf', () => {
  test('the platform names map to the closed OS set; anything else is other', () => {
    expect(osOf('darwin')).toBe('macos')
    expect(osOf('linux')).toBe('linux')
    expect(osOf('win32')).toBe('windows')
    expect(osOf('freebsd')).toBe('other')
  })

  test('a trailing .local is dropped and the name is cut to 60 characters', () => {
    expect(hostOf('ana-laptop.local')).toBe('ana-laptop')
    expect(hostOf('  Desk.LOCAL ')).toBe('Desk')
    expect(hostOf('x'.repeat(80))).toHaveLength(60)
  })

  test('an IPv4 address, an IPv6 address, an empty name and localhost are not usable', () => {
    expect(hostOf('192.168.1.7')).toBeUndefined()
    expect(hostOf('10.0.0.12\n')).toBeUndefined()
    expect(hostOf('2001:db8::1')).toBeUndefined()
    expect(hostOf('fe80::1%en0')).toBeUndefined()
    expect(hostOf('   ')).toBeUndefined()
    expect(hostOf(undefined)).toBeUndefined()
    expect(hostOf('localhost')).toBeUndefined()
    expect(hostOf('LOCALHOST.local')).toBeUndefined()
  })
})

describe('hostNameOf', () => {
  test('a usable os.hostname() is the host, the macOS probes are not asked', async () => {
    let asked = false
    const host = await hostNameOf('macos', {
      ...MAC_LAPTOP,
      hostname: () => 'ana-laptop.local',
      localHostName: async () => {
        asked = true
        return 'other'
      },
    })
    expect(host).toBe('ana-laptop')
    expect(asked).toBe(false)
  })

  test('a Mac whose hostname is an IP address uses scutil LocalHostName, without the .local suffix', async () => {
    expect(await hostNameOf('macos', { ...MAC_LAPTOP, hostname: () => '192.168.1.7' })).toBe(
      'ana-laptop',
    )
  })

  test('a failed scutil LocalHostName falls back to ComputerName, a failed one to this computer', async () => {
    const noLocal = {
      ...MAC_LAPTOP,
      hostname: () => 'fe80::1',
      localHostName: async () => undefined,
    }
    expect(await hostNameOf('macos', noLocal)).toBe("Ana's MacBook")
    expect(
      await hostNameOf('macos', {
        ...noLocal,
        computerName: async () => {
          throw new Error('scutil is missing')
        },
      }),
    ).toBe('this computer')
    expect(await hostNameOf('macos', { ...noLocal, computerName: async () => '' })).toBe(
      'this computer',
    )
  })

  test('scutil is not asked on Linux; there /etc/hostname is read, and a bad one is this computer', async () => {
    const linux = { ...MAC_LAPTOP, platform: () => 'linux', hostname: () => '10.1.2.3' }
    expect(await hostNameOf('linux', { ...linux, etcHostname: () => 'desk.lan\n' })).toBe(
      'desk.lan',
    )
    expect(await hostNameOf('linux', { ...linux, etcHostname: () => '127.0.1.1' })).toBe(
      'this computer',
    )
    expect(
      await hostNameOf('linux', {
        ...linux,
        etcHostname: () => {
          throw new Error('no file')
        },
      }),
    ).toBe('this computer')
  })

  test('the environment never carries an address: an IP host gives the scutil name in detectEnvironment', async () => {
    const env = await detectEnvironment({ ...MAC_LAPTOP, hostname: () => '192.168.1.7' })
    expect(env?.host).toBe('ana-laptop')
    expect(JSON.stringify(env)).not.toContain('192.168')
  })
})

describe('the device kind', () => {
  test('a Mac with an internal battery is a laptop; without one a desktop', async () => {
    expect(await deviceOf('macos', MAC_LAPTOP)).toBe('laptop')
    expect(
      await deviceOf('macos', {
        ...MAC_LAPTOP,
        batteryReport: async () => "Now drawing from 'AC Power'",
      }),
    ).toBe('desktop')
  })

  test('a Linux machine with a BAT power supply is a laptop, without one a desktop', async () => {
    expect(await deviceOf('linux', { ...MAC_LAPTOP, powerSupplies: () => ['AC', 'BAT0'] })).toBe(
      'laptop',
    )
    expect(await deviceOf('linux', { ...MAC_LAPTOP, powerSupplies: () => ['AC', 'ACAD'] })).toBe(
      'desktop',
    )
  })

  test('Windows and a failed probe are unknown; a phone is never guessed', async () => {
    expect(await deviceOf('windows', MAC_LAPTOP)).toBe('unknown')
    expect(await deviceOf('macos', { ...MAC_LAPTOP, batteryReport: async () => undefined })).toBe(
      'unknown',
    )
    expect(await deviceOf('linux', { ...MAC_LAPTOP, powerSupplies: none })).toBe('unknown')
    expect(
      await deviceOf('macos', {
        ...MAC_LAPTOP,
        batteryReport: async () => {
          throw new Error('pmset is missing')
        },
      }),
    ).toBe('unknown')
  })
})

describe('detectEnvironment', () => {
  test('a MacBook reports its host, macOS version (not the Darwin release), arch, device, zone and locale', async () => {
    expect(await detectEnvironment(MAC_LAPTOP)).toEqual({
      host: 'ana-laptop',
      os: 'macos',
      osVersion: '16.0',
      arch: 'arm64',
      device: 'laptop',
      timezone: 'Asia/Jakarta',
      locale: 'id-ID',
    })
  })

  test('a failed macOS version probe falls back to the release; a failed locale is left out', async () => {
    const env = await detectEnvironment({
      ...MAC_LAPTOP,
      macosVersion: async () => undefined,
      locale: none,
    })
    expect(env?.osVersion).toBe('25.6.0')
    expect(env).not.toHaveProperty('locale')
  })

  test('no time zone means no environment: the zone is required', async () => {
    expect(await detectEnvironment({ ...MAC_LAPTOP, timeZone: none })).toBeUndefined()
    expect(await detectEnvironment({ ...MAC_LAPTOP, timeZone: () => 'Not/AZone' })).toBeUndefined()
  })

  test('a probe that throws is never fatal: the call resolves to an environment or to nothing', async () => {
    const throwing = {
      ...MAC_LAPTOP,
      arch: () => {
        throw new Error('no arch')
      },
    }
    await expect(detectEnvironment(throwing)).resolves.toBeUndefined()
  })

  test('Windows reports the release as its version and an unknown device', async () => {
    const env = await detectEnvironment({
      ...MAC_LAPTOP,
      platform: () => 'win32',
      release: () => '10.0.22631',
      hostname: () => 'DESK',
    })
    expect(env).toMatchObject({
      os: 'windows',
      osVersion: '10.0.22631',
      device: 'unknown',
      host: 'DESK',
    })
  })
})

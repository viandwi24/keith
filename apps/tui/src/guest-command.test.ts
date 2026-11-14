import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '@keith/cli'
import { fakeIo } from '@keith/cli/testing'
import { writeClientConfig } from '@keith/client'
import { keithCommands } from './commands.tsx'
import { DEFAULT_GUEST_URL, GuestUrlError, guestUrlOf, guestUrlOfCore } from './guest-url.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('guestUrlOf', () => {
  test('the default is this machine on the guest port', () => {
    expect(guestUrlOf(undefined)).toBe(DEFAULT_GUEST_URL)
    expect(DEFAULT_GUEST_URL).toBe('http://127.0.0.1:7421')
  })
  test('an address with a port is kept; an http one with no port gets the guest port', () => {
    expect(guestUrlOf('http://192.168.1.20:7421/')).toBe('http://192.168.1.20:7421')
    expect(guestUrlOf('http://mac.local')).toBe('http://mac.local:7421')
    expect(guestUrlOf('https://keith.example.ts.net')).toBe('https://keith.example.ts.net')
    expect(guestUrlOf('http://mac.local:9000')).toBe('http://mac.local:9000')
  })
  test('the local socket and a non-http address are refused', () => {
    expect(() => guestUrlOf('unix:/tmp/core.sock')).toThrow(GuestUrlError)
    expect(() => guestUrlOf('ftp://x')).toThrow(GuestUrlError)
    expect(() => guestUrlOf('not a url')).toThrow(GuestUrlError)
  })
  test('a core the app is signed out of maps to its host on the default guest port; the socket has none', () => {
    expect(guestUrlOfCore('http://192.168.1.20:7420')).toBe('http://192.168.1.20:7421')
    expect(guestUrlOfCore('unix:/tmp/core.sock')).toBeUndefined()
  })
})

describe('keith --guest', () => {
  function run(argv: string[], configured = false) {
    const dir = mkdtempSync(join(tmpdir(), 'keith-guest-cmd-'))
    dirs.push(dir)
    const configPath = join(dir, 'client.json')
    // a stored login that must never be used or read for guest chat
    if (configured) writeClientConfig({ core: 'http://other.example:7420', token: 'x' }, configPath)
    const started: string[] = []
    const apps: unknown[] = []
    const io = fakeIo()
    return runCli({
      program: 'keith',
      version: '0.0.0',
      defaultCommand: 'home',
      argv,
      io,
      commands: keithCommands({
        configPath,
        dataDir: dir,
        startChat: async (c) => {
          apps.push(c)
          return 0
        },
        startHome: async (c) => {
          apps.push(c)
          return 0
        },
        startGuest: async (url) => {
          started.push(url)
          return 0
        },
      }),
    }).then((code) => ({ code, started, apps, err: io.err(), dir }))
  }

  test('opens the guest chat on --core with no login, no connection and nothing written', async () => {
    const r = await run(['--guest', '--core', 'http://10.0.0.5:7421'], true)
    expect(r.code).toBe(0)
    expect(r.started).toEqual(['http://10.0.0.5:7421'])
    // the stored login was not used: no app was opened on it
    expect(r.apps).toEqual([])
    expect(readdirSync(r.dir)).toEqual(['client.json'])
  })

  test('without --core it uses the default guest address', async () => {
    const r = await run(['--guest'])
    expect(r.started).toEqual([DEFAULT_GUEST_URL])
    expect(readdirSync(r.dir)).toEqual([])
  })

  test('a unix address is a usage error and starts nothing', async () => {
    const r = await run(['--guest', '--core', 'unix:/tmp/x.sock'])
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('not the local socket')
    expect(r.started).toEqual([])
  })
})

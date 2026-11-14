import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localSocketPath, writeClientConfig } from '@keith/client'
import {
  CoreFlagError,
  clientFor,
  coreLabel,
  parseCoreFlag,
  resolveConnection,
  signedInConnection,
} from './connection.ts'
import { forgetSession, rememberSession, sessionTokenOf } from './session-vault.ts'

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'keith-conn-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const yes = async () => true
const no = async () => false

describe('parseCoreFlag', () => {
  test('unix:<path> and http(s) URLs; anything else is refused', () => {
    expect(parseCoreFlag('unix:/a/core.sock')).toEqual({ kind: 'unix', path: '/a/core.sock' })
    expect(parseCoreFlag('https://mac.ts.net/')).toEqual({
      kind: 'http',
      url: 'https://mac.ts.net',
    })
    expect(() => parseCoreFlag('unix:')).toThrow(CoreFlagError)
    expect(() => parseCoreFlag('mac.ts.net')).toThrow(CoreFlagError)
    expect(() => parseCoreFlag('ftp://x')).toThrow(CoreFlagError)
  })
})

describe('resolveConnection order', () => {
  test('the --core flag wins over client.json and the socket', async () => {
    const dir = tmp()
    const configPath = join(dir, 'client.json')
    writeClientConfig({ core: 'http://stored:1', token: 'tok' }, configPath)
    expect(
      await resolveConnection({ core: 'unix:/x.sock', configPath, dataDir: dir, probe: yes }),
    ).toEqual({ kind: 'socket', path: '/x.sock', source: 'flag' })
    expect(
      await resolveConnection({ core: 'http://other:2', configPath, dataDir: dir, probe: yes }),
    ).toEqual({ kind: 'http', url: 'http://other:2', source: 'flag' })
  })

  test('a http flag naming the stored core reuses its token', async () => {
    const dir = tmp()
    const configPath = join(dir, 'client.json')
    writeClientConfig({ core: 'http://stored:1/', token: 'tok' }, configPath)
    expect(
      await resolveConnection({ core: 'http://stored:1', configPath, dataDir: dir, probe: no }),
    ).toEqual({ kind: 'http', url: 'http://stored:1', token: 'tok', source: 'flag' })
  })

  test('client.json wins over the local socket', async () => {
    const dir = tmp()
    const configPath = join(dir, 'client.json')
    writeClientConfig({ core: 'http://stored:1', token: 'tok' }, configPath)
    expect(await resolveConnection({ configPath, dataDir: dir, probe: yes })).toEqual({
      kind: 'http',
      url: 'http://stored:1',
      token: 'tok',
      source: 'file',
    })
  })

  test('with no flag and no login, the socket of the default data dir is used when it answers', async () => {
    const dir = tmp()
    const probed: string[] = []
    const found = await resolveConnection({
      configPath: join(dir, 'none.json'),
      dataDir: dir,
      probe: async (p) => {
        probed.push(p)
        return true
      },
    })
    expect(found).toEqual({ kind: 'socket', path: join(dir, 'core.sock'), source: 'socket' })
    expect(probed).toEqual([join(dir, 'core.sock')])
  })

  test('the socket path recorded by core (long data dir) is the one probed', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'core.sock.path'), '/tmp/keith-abc.sock\n')
    const found = await resolveConnection({
      configPath: join(dir, 'x.json'),
      dataDir: dir,
      probe: yes,
    })
    expect(found).toEqual({ kind: 'socket', path: '/tmp/keith-abc.sock', source: 'socket' })
    expect(localSocketPath(dir)).toBe('/tmp/keith-abc.sock')
  })

  test('nothing configured and nothing answering: undefined', async () => {
    const dir = tmp()
    expect(
      await resolveConnection({ configPath: join(dir, 'x.json'), dataDir: dir, probe: no }),
    ).toBeUndefined()
  })
})

describe('clientFor', () => {
  test('a socket connection talks over the Unix socket with no token', async () => {
    const dir = tmp()
    const path = join(dir, 'core.sock')
    const seen: Array<string | null> = []
    const server = Bun.serve({
      unix: path,
      fetch: (req) => {
        seen.push(req.headers.get('authorization'))
        return Response.json({
          json: {
            personId: 'owner',
            name: 'Owner',
            role: 'owner',
            via: 'local',
            credentialKind: null,
          },
        })
      },
    })
    try {
      const connection = { kind: 'socket', path, source: 'socket' } as const
      const me = await clientFor(connection).rpc.auth.whoami()
      expect(me.via).toBe('local')
      expect(seen).toEqual([null])
      expect(coreLabel(connection)).toBe(`unix:${path}`)
    } finally {
      await server.stop(true)
    }
  })
})

describe('the session of a socket that needs one (local trust none, the default)', () => {
  test('a socket connection never has a token from disk; a leftover socket-session.json is deleted unread', async () => {
    const dir = tmp()
    const configPath = join(dir, 'client.json')
    const old = join(dir, 'socket-session.json')
    writeFileSync(old, '{"token":"keith_s_socket"}\n')
    expect(
      await resolveConnection({ core: 'unix:/a/core.sock', configPath, dataDir: dir }),
    ).toEqual({ kind: 'socket', path: '/a/core.sock', source: 'flag' })
    expect(existsSync(old)).toBe(false)
    // the default socket: every start begins signed out
    writeFileSync(old, '{"token":"keith_s_socket"}\n')
    const found = await resolveConnection({ configPath, dataDir: dir, probe: yes })
    expect(found).toEqual({ kind: 'socket', path: join(dir, 'core.sock'), source: 'socket' })
    expect(existsSync(old)).toBe(false)
    // a login to a remote core still wins over the socket
    writeClientConfig({ core: 'https://mac.ts.net', token: 'keith_s_remote' }, configPath)
    expect(await resolveConnection({ configPath, dataDir: dir, probe: yes })).toEqual({
      kind: 'http',
      url: 'https://mac.ts.net',
      token: 'keith_s_remote',
      source: 'file',
    })
  })

  test('the client sends the token as a bearer over the socket', async () => {
    const dir = tmp()
    const path = join(dir, 's.sock')
    const seen: Array<string | null> = []
    const server = Bun.serve({
      unix: path,
      fetch(request) {
        seen.push(request.headers.get('authorization'))
        return Response.json({ json: { status: 'ok', version: '0.0.0', sha: 'x', boot: 'b' } })
      },
    })
    try {
      await clientFor({ kind: 'socket', path, source: 'flag', token: 'keith_s_t' }).rpc.health.get()
      expect(seen).toEqual(['Bearer keith_s_t'])
    } finally {
      await server.stop(true)
    }
  })
})

describe('the app on a terminal never signs in with a login the person did not keep', () => {
  const REMOTE = 'https://mac.ts.net'
  const saved = (dir: string, remember: boolean): string => {
    const configPath = join(dir, 'client.json')
    writeClientConfig(
      { core: REMOTE, token: 'keith_s_saved', ...(remember ? { remember: true as const } : {}) },
      configPath,
    )
    return configPath
  }

  test('a legacy login is skipped: the socket is used, signed out', async () => {
    const dir = tmp()
    const configPath = saved(dir, false)
    expect(
      await resolveConnection({ configPath, dataDir: dir, probe: yes, interactive: true }),
    ).toEqual({ kind: 'socket', path: join(dir, 'core.sock'), source: 'socket' })
    // without a socket nothing resolves: the app opens its sign-in
    expect(
      await resolveConnection({ configPath, dataDir: dir, probe: no, interactive: true }),
    ).toBeUndefined()
  })

  test('commands and scripts keep using the same login exactly as before', async () => {
    const dir = tmp()
    const configPath = saved(dir, false)
    expect(await resolveConnection({ configPath, dataDir: dir, probe: yes })).toEqual({
      kind: 'http',
      url: REMOTE,
      token: 'keith_s_saved',
      source: 'file',
    })
    expect(
      await resolveConnection({ core: REMOTE, configPath, dataDir: dir, probe: no }),
    ).toMatchObject({ token: 'keith_s_saved', source: 'flag' })
  })

  test('--core on the saved core gets no token from a legacy login', async () => {
    const dir = tmp()
    const configPath = saved(dir, false)
    expect(
      await resolveConnection({
        core: REMOTE,
        configPath,
        dataDir: dir,
        probe: no,
        interactive: true,
      }),
    ).toEqual({ kind: 'http', url: REMOTE, source: 'flag' })
  })

  test('a remembered login signs in silently, ahead of the socket, and for --core on its core', async () => {
    const dir = tmp()
    const configPath = saved(dir, true)
    expect(
      await resolveConnection({ configPath, dataDir: dir, probe: yes, interactive: true }),
    ).toEqual({ kind: 'http', url: REMOTE, token: 'keith_s_saved', source: 'file' })
    expect(
      await resolveConnection({
        core: REMOTE,
        configPath,
        dataDir: dir,
        probe: no,
        interactive: true,
      }),
    ).toMatchObject({ token: 'keith_s_saved', source: 'flag' })
    // another core named by --core gets no token
    expect(
      await resolveConnection({
        core: 'http://other:9',
        configPath,
        dataDir: dir,
        probe: no,
        interactive: true,
      }),
    ).toEqual({ kind: 'http', url: 'http://other:9', source: 'flag' })
  })

  test('a sign-in of this process is in memory: the app swaps to it and /logout drops it', async () => {
    const dir = tmp()
    const configPath = join(dir, 'client.json')
    rememberSession(`${REMOTE}/`, 'keith_s_memory')
    expect(await signedInConnection(REMOTE, configPath)).toEqual({
      kind: 'http',
      url: REMOTE,
      token: 'keith_s_memory',
      source: 'session',
    })
    expect(existsSync(configPath)).toBe(false)
    forgetSession(REMOTE)
    expect(sessionTokenOf(REMOTE)).toBeUndefined()
  })
})

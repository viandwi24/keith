import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKeithClient } from './client.ts'
import { localSocketPath, probeSocket, socketFetch } from './socket.ts'

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ks-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('localSocketPath', () => {
  test('a short data dir uses <dataDir>/core.sock', () => {
    const dir = tmp()
    expect(localSocketPath(dir)).toBe(join(dir, 'core.sock'))
  })

  test('a long data dir falls back to a hashed path in the temp dir', () => {
    const dir = join(tmp(), 'x'.repeat(120))
    const path = localSocketPath(dir, '/tmpx')
    expect(path).toMatch(/^\/tmpx\/keith-[0-9a-f]{12}\.sock$/)
    expect(localSocketPath(dir, '/tmpx')).toBe(path)
  })

  test('the path core recorded wins', () => {
    const dir = tmp()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'core.sock.path'), '/somewhere/else.sock\n')
    expect(localSocketPath(dir)).toBe('/somewhere/else.sock')
  })
})

describe('socket client', () => {
  test('probes and talks over a unix socket without a token', async () => {
    const path = join(tmp(), 'core.sock')
    expect(await probeSocket(path)).toBe(false)
    const auth: Array<string | null> = []
    const server = Bun.serve({
      unix: path,
      fetch: (req) => {
        auth.push(req.headers.get('authorization'))
        return Response.json({ status: 'ok' })
      },
    })
    try {
      expect(await probeSocket(path)).toBe(true)
      const res = await socketFetch(path)('http://localhost/health')
      expect(((await res.json()) as { status: string }).status).toBe('ok')
      createKeithClient({ baseUrl: 'http://localhost', fetch: socketFetch(path) })
      expect(auth.every((a) => a === null)).toBe(true)
    } finally {
      await server.stop(true)
    }
  })
})

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { createCredential } from '../modules/auth/index.ts'
import { loadConfig } from '../platform/config.ts'
import { type BootedCore, bootCore } from '../testing/boot-core.ts'
import { testIo } from '../testing/cli-io.ts'
import type { CliDeps } from './context.ts'
import { runCoreCli } from './program.ts'

// `keith-core rooms list|show|end` (docs/specs/corpus-callosum.md "CLI and TUI"). list and show read the headers from the
// database; end goes through the running core and is audited. No transcript text ever reaches the CLI output.
let b: BootedCore
let db: Sqlite
let deps: CliDeps
let planningId: string
let sideId: string
const MARKER = 'quiet-marker-7731'

beforeAll(async () => {
  b = await bootCore()
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir }).dbFile)
  deps = { env: { KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' } }
  for (const username of ['ana', 'bob']) await b.local.rpc.admin.people.add({ username })
  await b.local.rpc.admin.people.grant({ person: 'ana', capability: 'rooms.start' })
  // the owner's own room, with an invitation out (state open)
  planningId = (await b.local.rpc.rooms.start({ name: 'Planning', invite: ['bob'] })).room.id
  // a room ana started and bob joined (state active); the owner did not start it
  const ana = await memberOf('ana')
  const bob = await memberOf('bob')
  const side = await ana.rpc.rooms.start({ name: 'Side talk', invite: ['bob'] })
  sideId = side.room.id
  await bob.rpc.rooms.accept({ roomId: sideId })
  await ana.rpc.rooms.say({ roomId: sideId, text: MARKER })
})

afterAll(async () => {
  db.close()
  await b.stop()
})

async function memberOf(name: string) {
  const person = await b.local.rpc.admin.people.get({ person: name })
  const { token } = await createCredential(credentialsRepo(db), {
    personId: person.id,
    kind: 'token',
    label: `${name}-rooms-cli`,
  })
  return b.tcp(token)
}

async function cli(...argv: string[]) {
  const io = testIo()
  io.end()
  const code = await runCoreCli(argv, io, deps)
  return { code, out: io.out(), err: io.err() }
}

const auditRows = async (kind: string) =>
  (await b.local.rpc.admin.audit.list({ limit: 500 })).filter((e) => e.kind === kind)

describe('rooms list', () => {
  test('lists every room, newest first, with state and members (headers only)', async () => {
    const res = await cli('rooms', 'list')
    expect(res.code).toBe(0)
    expect(res.out).toContain('ID')
    expect(res.out).toContain('STATE')
    expect(res.out).toContain(planningId)
    expect(res.out).toContain(sideId)
    const sideLine = res.out.split('\n').find((line) => line.includes(sideId)) ?? ''
    expect(sideLine).toContain('active')
    expect(sideLine).toContain('Side talk')
    expect(sideLine).toContain('ana')
    expect(sideLine).toContain('bob')
    const planningLine = res.out.split('\n').find((line) => line.includes(planningId)) ?? ''
    expect(planningLine).toContain('open')
    expect(planningLine).toContain('(+ 1 invited)')
  })

  test('prints no transcript text', async () => {
    const res = await cli('rooms', 'list')
    expect(res.out).not.toContain(MARKER)
  })

  test('--limit takes a whole number from 1 to 200', async () => {
    const one = await cli('rooms', 'list', '--limit', '1')
    expect(one.code).toBe(0)
    expect(one.out.trim().split('\n')).toHaveLength(2) // the header and one row
    expect((await cli('rooms', 'list', '--limit', '0')).code).toBe(2)
    expect((await cli('rooms', 'list', '--limit', '201')).code).toBe(2)
    expect((await cli('rooms', 'list', '--limit', 'many')).code).toBe(2)
  })
})

describe('rooms show', () => {
  test('prints the header and the members with their status, and no transcript text', async () => {
    const res = await cli('rooms', 'show', sideId)
    expect(res.code).toBe(0)
    expect(res.out).toContain(`id: ${sideId}`)
    expect(res.out).toContain('name: Side talk')
    expect(res.out).toContain('state: active')
    expect(res.out).toContain('initiator: ana')
    expect(res.out).toContain('members:')
    expect(res.out).toMatch(/ana\s+active/)
    expect(res.out).toMatch(/bob\s+active/)
    expect(res.out).not.toContain(MARKER)
  })

  test('an unknown id is refused, a missing id is a usage error', async () => {
    const unknown = await cli('rooms', 'show', '11111111-1111-4111-8111-111111111111')
    expect(unknown.code).toBe(1)
    expect(unknown.err).toContain('there is no such room')
    expect((await cli('rooms', 'show')).code).toBe(2)
    expect((await cli('rooms', 'show', sideId, 'extra')).code).toBe(2)
  })
})

describe('rooms end', () => {
  test('the owner ends a room another member started: through the core, audited room.end and room.owner-end', async () => {
    const res = await cli('rooms', 'end', sideId, '--reason', 'wrap up', '--yes')
    expect(res.code).toBe(0)
    expect(res.out).toContain(`room ${sideId} ended: wrap up`)
    const shown = await cli('rooms', 'show', sideId)
    expect(shown.out).toContain('state: ended')
    expect(shown.out).toContain('reason: wrap up')
    const owner = (await auditRows('room.owner-end')).filter((r) => r.detail?.roomId === sideId)
    expect(owner).toHaveLength(1)
    expect(owner[0]?.detail).toMatchObject({ roomId: sideId, reason: 'wrap up' })
    expect((await auditRows('room.end')).some((r) => r.detail?.roomId === sideId)).toBe(true)
  })

  test('an ended room is refused by the core and nothing changes', async () => {
    const res = await cli('rooms', 'end', sideId, '--yes')
    expect(res.code).not.toBe(0)
    const owner = (await auditRows('room.owner-end')).filter((r) => r.detail?.roomId === sideId)
    expect(owner).toHaveLength(1)
  })

  test('the owner ends their own room: room.end only, no room.owner-end', async () => {
    const res = await cli('rooms', 'end', planningId, '--yes')
    expect(res.code).toBe(0)
    const owner = (await auditRows('room.owner-end')).filter((r) => r.detail?.roomId === planningId)
    expect(owner).toHaveLength(0)
    expect((await auditRows('room.end')).some((r) => r.detail?.roomId === planningId)).toBe(true)
  })

  test('usage: a missing id is exit 2; an unknown room is refused by the core', async () => {
    expect((await cli('rooms', 'end')).code).toBe(2)
    const unknown = await cli('rooms', 'end', '11111111-1111-4111-8111-111111111111', '--yes')
    expect(unknown.code).not.toBe(0)
  })
})

describe('rooms in the help', () => {
  test('--help lists list, show and end', async () => {
    const top = await cli('--help')
    expect(top.out).toContain('rooms')
    const help = await cli('rooms', '--help')
    expect(help.code).toBe(0)
    expect(help.out).toContain('list')
    expect(help.out).toContain('show')
    expect(help.out).toContain('end')
  })
})

describe('rooms list with the core stopped', () => {
  test('the database is read directly: a folder without a database is refused as not set up', async () => {
    const empty = { env: { KEITH_DATA_DIR: `${b.dir}-empty`, KEITH_BUILD_SHA: 'test' } }
    const io = testIo()
    io.end()
    const code = await runCoreCli(['rooms', 'list'], io, empty)
    expect(code).toBe(1)
    expect(io.err()).toContain('keith-core setup')
  })
})

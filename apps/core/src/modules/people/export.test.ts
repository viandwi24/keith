import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import type { CliDeps } from '../../cli/context.ts'
import { runCoreCli } from '../../cli/program.ts'
import { extractArchive } from '../../platform/archive.ts'
import { type BootedCore, bootCore, stepUp } from '../../testing/boot-core.ts'
import { testIo } from '../../testing/cli-io.ts'
import { createCredential } from '../auth/index.ts'
import { personWorkspaceDir } from '../cortex/index.ts'
import { memoryDir } from '../hippocampus/index.ts'

// `people export` (ADR-0027 §26): the owner gets an archive of a person's data, a delegate never does.
let b: BootedCore
let db: Sqlite
let deps: CliDeps

beforeAll(async () => {
  b = await bootCore()
  db = openDatabase(join(b.dir, 'keith.db'))
  deps = { env: { KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' } }
  for (const name of ['ana', 'duta']) await b.local.rpc.admin.people.add({ username: name })
  const ana = await b.local.rpc.admin.people.get({ person: 'ana' })
  mkdirSync(memoryDir(b.dir, ana.id), { recursive: true })
  writeFileSync(join(memoryDir(b.dir, ana.id), 'profile.md'), 'likes tea')
  mkdirSync(personWorkspaceDir(b.dir, ana.id), { recursive: true })
  writeFileSync(join(personWorkspaceDir(b.dir, ana.id), 'notes.txt'), 'draft')
  db.query(
    "INSERT INTO eh_messages (session_id, id, role, parts, metadata, created_at) VALUES (?, '01', 'user', '[]', NULL, 1)",
  ).run(`front:${ana.id}`)
})
afterAll(async () => {
  db.close()
  await b.stop()
})

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  )
const entriesOf = async (path: string): Promise<string[]> =>
  [...(await new Bun.Archive(readFileSync(path)).files()).keys()].sort()
const kindsOf = async (kind: string) =>
  (await b.local.rpc.admin.audit.list({ limit: 500 })).filter((e) => e.kind === kind)

describe('people export', () => {
  test('the owner gets an archive of memory, workspace and conversation, mode 0600, and it is audited', async () => {
    const out = await b.local.rpc.admin.people.export({ person: 'ana' })
    expect(out.path.startsWith(join(b.dir, 'exports'))).toBe(true)
    expect(statSync(out.path).mode & 0o777).toBe(0o600)
    expect(await entriesOf(out.path)).toEqual(
      expect.arrayContaining([
        'conversation.jsonl',
        'manifest.json',
        'memory/profile.md',
        'workspace/notes.txt',
      ]),
    )
    expect(out.files).toBeGreaterThanOrEqual(4)
    expect((await kindsOf('person.exported')).length).toBeGreaterThanOrEqual(1)
    expect((await kindsOf('acl.owner-access')).some((e) => e.detail?.reason === 'export')).toBe(
      true,
    )
  })

  test('a delegate with people.manage is refused, even after a step-up', async () => {
    await b.local.rpc.admin.people.grant({ person: 'duta', capability: 'people.manage' })
    const { token } = await createCredential(credentialsRepo(db), {
      personId: (await b.local.rpc.admin.people.get({ person: 'duta' })).id,
      kind: 'token',
      label: 'duta-tcp',
    })
    const tcp = b.tcp(token)
    await stepUp(b, token, 'duta')
    expect(await code(tcp.rpc.admin.people.export({ person: 'ana' }))).toBe('FORBIDDEN')
  })

  test('a removed person is exported by id while the data is kept; an unknown id is refused', async () => {
    await b.local.rpc.admin.people.add({ username: 'gina' })
    const gina = await b.local.rpc.admin.people.get({ person: 'gina' })
    mkdirSync(memoryDir(b.dir, gina.id), { recursive: true })
    writeFileSync(join(memoryDir(b.dir, gina.id), 'profile.md'), 'gone soon')
    const removed = await b.local.rpc.admin.people.remove({ person: 'gina' })
    const out = await b.local.rpc.admin.people.export({ removed: removed.id })
    expect(out.personId).toBe(gina.id)
    expect(await entriesOf(out.path)).toContain('memory/profile.md')
    expect(await code(b.local.rpc.admin.people.export({ removed: 'nobody-here' }))).toBe(
      'NOT_FOUND',
    )
  })

  test('the archive keeps the modes of the files (tar, not an object archive): an executable stays executable', async () => {
    await b.local.rpc.admin.people.add({ username: 'ben' })
    const benId = (await b.local.rpc.admin.people.get({ person: 'ben' })).id
    mkdirSync(personWorkspaceDir(b.dir, benId), { recursive: true })
    const script = join(personWorkspaceDir(b.dir, benId), 'run.sh')
    writeFileSync(script, 'echo hi')
    chmodSync(script, 0o755)
    const out = await b.local.rpc.admin.people.export({ person: 'ben' })
    const dest = mkdtempSync(join(tmpdir(), 'keith-export-modes-'))
    try {
      await extractArchive(out.path, dest)
      expect(statSync(join(dest, 'workspace', 'run.sh')).mode & 0o777).toBe(0o755)
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })

  test('name one thing: a username or --removed, never neither or both', async () => {
    expect(await code(b.local.rpc.admin.people.export({}))).toBe('BAD_REQUEST')
    expect(await code(b.local.rpc.admin.people.export({ person: 'ana', removed: 'x' }))).toBe(
      'BAD_REQUEST',
    )
  })

  test('the CLI copies the archive to --out with mode 0600 and names the person', async () => {
    const io = testIo()
    io.end()
    const target = join(b.dir, 'ana-export.tar')
    const code = await runCoreCli(['people', 'export', 'ana', '--out', target], io, deps)
    expect(code).toBe(0)
    expect(io.out()).toContain(`to ${target}`)
    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(existsSync(target)).toBe(true)
    expect(await entriesOf(target)).toContain('memory/profile.md')
  })
})

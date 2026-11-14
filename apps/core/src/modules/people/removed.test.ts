import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
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
import { migrateDatabase, openDatabase, type Sqlite } from '@keith/db'
import { personWorkspaceDir, workspaceOf } from '../cortex/index.ts'
import { memoryDir } from '../hippocampus/index.ts'
import { PeopleError } from './people.ts'
import type { PersonRemovalHooks } from './removal-registry.ts'
import {
  createRemoval,
  type RemovalService,
  readRemovedManifest,
  removedFolderOf,
  removedRootOf,
} from './removed.ts'

const DAY = 86_400_000
let dataDir: string
let sqlite: Sqlite
let clock: number
let audit: { kind: string; actor: string; via: string; detail: Record<string, unknown> }[]

/** Seed the rows a person leaves behind: their front session, one worker, and somebody else. */
function seedMessages(): void {
  const insert = sqlite.query(
    'INSERT INTO eh_messages (session_id, id, role, parts, metadata, created_at) VALUES (?, ?, ?, ?, NULL, 1)',
  )
  insert.run('front:ana', '01', 'user', '[{"text":"ana front"}]')
  insert.run('front:ana:agent:c1', '02', 'assistant', '[{"text":"ana worker"}]')
  insert.run('front:anabel', '03', 'user', '[{"text":"anabel is not ana"}]')
  insert.run('front:bob', '04', 'user', '[{"text":"bob"}]')
}
const messageCount = (session: string): number =>
  (
    sqlite.query('SELECT COUNT(*) AS n FROM eh_messages WHERE session_id = ?').get(session) as {
      n: number
    }
  ).n

function service(keepMs = 30 * DAY): RemovalService {
  return createRemoval({
    dataDir,
    keepMs,
    sqlite,
    audit: { record: (entry) => void audit.push({ ...entry, detail: entry.detail ?? {} }) },
    now: () => clock,
  })
}
const ana = { id: 'ana', username: 'ana', name: 'Ana' }

function seedFiles(): void {
  mkdirSync(join(memoryDir(dataDir, 'ana')), { recursive: true })
  writeFileSync(join(memoryDir(dataDir, 'ana'), 'profile.md'), 'likes tea')
  mkdirSync(personWorkspaceDir(dataDir, 'ana'), { recursive: true })
  writeFileSync(join(personWorkspaceDir(dataDir, 'ana'), 'run.sh'), 'echo hi', { mode: 0o755 })
  mkdirSync(memoryDir(dataDir, 'bob'), { recursive: true })
  writeFileSync(join(memoryDir(dataDir, 'bob'), 'profile.md'), 'bob stays')
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-removed-'))
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  clock = 1_000
  audit = []
  seedFiles()
  seedMessages()
})
afterEach(() => {
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('keeping a removed person', () => {
  test('memory and workspace move, the conversation is written and its rows go; another person is untouched', async () => {
    const kept = await service().keep(ana)
    const folder = removedFolderOf(dataDir, 'ana')

    expect(kept.keptUntil).toBe(clock + 30 * DAY)
    expect(existsSync(memoryDir(dataDir, 'ana'))).toBe(false)
    expect(readFileSync(join(folder, 'memory', 'profile.md'), 'utf8')).toBe('likes tea')
    expect(statSync(join(folder, 'workspace', 'run.sh')).mode & 0o777).toBe(0o755)
    expect(existsSync(personWorkspaceDir(dataDir, 'ana'))).toBe(false)

    const lines = readFileSync(join(folder, 'conversation.jsonl'), 'utf8').trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).session_id)).toEqual(['front:ana', 'front:ana:agent:c1'])
    expect(messageCount('front:ana')).toBe(0)
    expect(messageCount('front:ana:agent:c1')).toBe(0)
    expect(messageCount('front:anabel')).toBe(1)
    expect(readFileSync(join(memoryDir(dataDir, 'bob'), 'profile.md'), 'utf8')).toBe('bob stays')
    expect(messageCount('front:bob')).toBe(1)
  })

  test('the manifest holds the person and both dates, mode 0600, in a 0700 folder', async () => {
    await service().keep(ana)
    const folder = removedFolderOf(dataDir, 'ana')
    expect(readRemovedManifest(folder)).toEqual({
      personId: 'ana',
      username: 'ana',
      name: 'Ana',
      removedAt: clock,
      purgeAt: clock + 30 * DAY,
    })
    expect(statSync(join(folder, 'manifest.json')).mode & 0o777).toBe(0o600)
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    expect(statSync(join(folder, 'conversation.jsonl')).mode & 0o777).toBe(0o600)
  })

  test('a part that fails refuses the removal and changes nothing', async () => {
    const svc = service()
    svc.registry.registerRemoval({
      module: 'broken',
      onPersonRemoved: {
        keep: (): never => {
          throw new Error('disk is read-only')
        },
        export: () => {},
        purge: () => {},
      },
    })
    await expect(svc.keep(ana)).rejects.toThrow('disk is read-only')
    expect(existsSync(memoryDir(dataDir, 'ana'))).toBe(true)
    expect(existsSync(personWorkspaceDir(dataDir, 'ana'))).toBe(true)
    expect(messageCount('front:ana')).toBe(1)
    expect(existsSync(removedFolderOf(dataDir, 'ana'))).toBe(false)
  })

  test('undo puts memory, workspace and the rows back and removes the kept folder', async () => {
    const kept = await service().keep(ana)
    await kept.undo()
    expect(readFileSync(join(memoryDir(dataDir, 'ana'), 'profile.md'), 'utf8')).toBe('likes tea')
    expect(existsSync(personWorkspaceDir(dataDir, 'ana'))).toBe(true)
    expect(messageCount('front:ana')).toBe(1)
    expect(messageCount('front:ana:agent:c1')).toBe(1)
    expect(existsSync(removedFolderOf(dataDir, 'ana'))).toBe(false)
  })

  test('two removals never share a folder: a second keep of the same person is refused', async () => {
    const svc = service()
    await svc.keep(ana)
    const again = svc.keep(ana)
    await expect(again).rejects.toBeInstanceOf(PeopleError)
    await expect(again).rejects.toThrow('already kept')
  })

  test('an id that cannot name a folder is refused', async () => {
    await expect(service().keep({ id: '../owner', username: null, name: 'x' })).rejects.toThrow(
      'cannot name a folder',
    )
  })

  test('a module registered by a test is kept and purged by the same calls', async () => {
    const svc = service()
    const calls: string[] = []
    const extra: PersonRemovalHooks = {
      keep: (personId, folder) => {
        calls.push(`keep ${personId} ${folder.endsWith('ana')}`)
        return undefined
      },
      export: () => {},
      purge: (personId) => {
        calls.push(`purge ${personId}`)
      },
    }
    svc.registry.registerRemoval({ module: 'extra', onPersonRemoved: extra })
    await svc.keep(ana)
    clock += 30 * DAY
    await svc.purge()
    expect(calls).toEqual(['keep ana true', 'purge ana'])
  })

  test('a module name can be registered once only', () => {
    const svc = service()
    const hooks = { keep: () => undefined, export: () => {}, purge: () => {} }
    svc.registry.registerRemoval({ module: 'x', onPersonRemoved: hooks })
    expect(() => svc.registry.registerRemoval({ module: 'x', onPersonRemoved: hooks })).toThrow(
      'registered twice',
    )
  })
})

describe('purging after the keep time', () => {
  test('nothing is purged before the time; after it the folder goes and the purge is audited', async () => {
    const svc = service()
    await svc.keep(ana)
    clock += 30 * DAY - 1
    expect((await svc.purge()).purged).toEqual([])
    expect(existsSync(removedFolderOf(dataDir, 'ana'))).toBe(true)

    clock += 1
    expect((await svc.purge()).purged).toEqual(['ana'])
    expect(existsSync(removedFolderOf(dataDir, 'ana'))).toBe(false)
    expect(audit).toContainEqual({
      kind: 'person.removed.purged',
      actor: 'system',
      via: 'local',
      detail: { person: 'ana', subject: 'ana' },
    })
  })

  test('a folder without a valid manifest is never purged', async () => {
    const stray = join(removedRootOf(dataDir), 'stray')
    mkdirSync(stray, { recursive: true })
    writeFileSync(join(stray, 'note.txt'), 'not ours')
    const mismatch = join(removedRootOf(dataDir), 'mismatch')
    mkdirSync(mismatch, { recursive: true })
    writeFileSync(
      join(mismatch, 'manifest.json'),
      JSON.stringify({ personId: 'other', name: 'x', removedAt: 0, purgeAt: 0 }),
    )
    clock += 365 * DAY
    expect((await service().purge()).purged).toEqual([])
    expect(existsSync(join(stray, 'note.txt'))).toBe(true)
    expect(existsSync(mismatch)).toBe(true)
  })

  test('the workspace layout keeps removed data out of every worker mount', async () => {
    await service().keep(ana)
    const removed = removedFolderOf(dataDir, 'ana')
    // a worker of any person mounts only its own folder under workspace/people
    for (const person of ['bob', 'ana']) {
      const mount = workspaceOf(dataDir, { principal: { id: person } } as never)
      expect(mount).toBe(personWorkspaceDir(dataDir, person))
      expect(removed.startsWith(`${mount}/`)).toBe(false)
      expect(mount?.includes(`${join('workspace', 'keith')}`)).toBe(false)
    }
    expect(removed.startsWith(join(dataDir, 'workspace', 'keith'))).toBe(true)
  })
})

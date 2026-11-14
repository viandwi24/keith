import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWorkspacePath, type WorkspaceCaller } from './workspace.ts'

// Real folders in a temp data dir: A and B have files, room R1 has A as member, room R2 does not.
let dataDir: string
const root = () => join(dataDir, 'workspace')
const members: Record<string, string[]> = { R1: ['A'], R2: ['B'] }
const caller = (person: string): WorkspaceCaller => ({
  dataDir,
  person,
  isRoomMember: (roomId, who) => members[roomId]?.includes(who) === true,
})

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-ws-'))
  for (const dir of ['people/A', 'people/B', 'rooms/R1', 'rooms/R2', 'keith/legacy']) {
    mkdirSync(join(root(), dir), { recursive: true })
  }
  writeFileSync(join(root(), 'people/A/notes.txt'), 'a notes')
  writeFileSync(join(root(), 'people/B/secret.txt'), 'b secret')
  writeFileSync(join(root(), 'rooms/R1/plan.md'), 'room plan')
  writeFileSync(join(root(), 'rooms/R2/other.md'), 'other room')
  writeFileSync(join(root(), 'keith/legacy/old.txt'), 'legacy')
  writeFileSync(join(dataDir, 'outside.txt'), 'outside')
  symlinkSync(join(dataDir, 'outside.txt'), join(root(), 'people/A/out-link'))
  symlinkSync(join(root(), 'people/B'), join(root(), 'people/A/b-link'))
  symlinkSync(join(root(), 'rooms/R2'), join(root(), 'people/A/r2-link'))
  symlinkSync(join(root(), 'keith'), join(root(), 'people/A/keith-link'))
  symlinkSync(join(root(), 'people/A/missing'), join(root(), 'people/A/dangling'))
  symlinkSync(join(root(), 'people/B'), join(root(), 'people/A/dir-link'))
  symlinkSync(join(root(), 'people/B'), join(root(), 'people/B/self-link'))
})

afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

describe('resolveWorkspacePath: what a person may name', () => {
  test.each([
    ['notes.txt', 'people/A/notes.txt'],
    ['./people/A/notes.txt', 'people/A/notes.txt'],
    ['people/A/notes.txt', 'people/A/notes.txt'],
    ['people/A/new/output.csv', 'people/A/new/output.csv'],
    ['rooms/R1/plan.md', 'rooms/R1/plan.md'],
  ])('%s is allowed for A as %s', (path, logical) => {
    const result = resolveWorkspacePath(caller('A'), path)
    expect(result).toMatchObject({ ok: true, file: { path: logical } })
  })

  test('the real path is inside the folder the path names', () => {
    const result = resolveWorkspacePath(caller('A'), 'notes.txt')
    expect(result.ok && result.file.real).toBe(join(realpathSync(root()), 'people/A/notes.txt'))
  })

  const refused: Array<[string, string, string]> = [
    ["B's file asked by A", 'A', 'people/B/secret.txt'],
    ['bare name resolved to B is not reachable', 'A', '../B/secret.txt'],
    ['dot-dot inside own folder', 'A', 'people/A/../B/secret.txt'],
    ['dot-dot at the start', 'A', '../outside.txt'],
    ['absolute path', 'A', '/etc/passwd'],
    ['windows drive path', 'A', 'C:/secret.txt'],
    ['keith folder', 'A', 'keith/legacy/old.txt'],
    ['keith folder without the prefix is still keith', 'A', 'keith/old.txt'],
    ['people without an id', 'A', 'people'],
    ['a room the caller is not in', 'A', 'rooms/R2/other.md'],
    ['a room folder itself', 'A', 'rooms/R1'],
    ['a folder is not a file', 'A', 'people/A'],
    ['a symlink to a file outside', 'A', 'out-link'],
    ['a symlink to another person folder', 'A', 'b-link/secret.txt'],
    ['a symlink to a folder of another person', 'A', 'dir-link/secret.txt'],
    ['a symlink to a room the caller is not in', 'A', 'r2-link/other.md'],
    ['a symlink to keith', 'A', 'keith-link/legacy/old.txt'],
    ['a dangling symlink', 'A', 'dangling'],
    ['an empty path', 'A', ''],
    ['a NUL byte', 'A', 'notes\0.txt'],
    ['a backslash', 'A', 'people\\B\\secret.txt'],
  ]
  test.each(refused)('refused: %s', (_label, who, path) => {
    const result = resolveWorkspacePath(caller(who), path)
    expect(result).toEqual({
      ok: false,
      code: 'path-refused',
      message: expect.any(String),
    })
  })

  test('a symlink that stays inside the own folder is followed', () => {
    expect(resolveWorkspacePath(caller('B'), 'self-link/secret.txt')).toMatchObject({ ok: true })
  })

  test('a caller with no usable id has no workspace', () => {
    expect(resolveWorkspacePath(caller('../x'), 'notes.txt').ok).toBe(false)
  })
})

describe('resolveWorkspacePath: rooms', () => {
  test('a room path is allowed only for a member', () => {
    expect(resolveWorkspacePath(caller('A'), 'rooms/R1/plan.md')).toMatchObject({ ok: true })
    expect(resolveWorkspacePath(caller('B'), 'rooms/R1/plan.md')).toMatchObject({
      ok: false,
      code: 'path-refused',
    })
  })

  test('without a membership check no room path is reachable', () => {
    const bare: WorkspaceCaller = { dataDir, person: 'A' }
    expect(resolveWorkspacePath(bare, 'rooms/R1/plan.md').ok).toBe(false)
  })
})

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Audit } from '../audit/index.ts'
import { prepareCall, type SandboxFilesOptions } from './sandbox-files.ts'

// Workspace files of a sandbox.run call: what leaves for the node, what is audited, and where outputs land (ADR-0021 §2).
let dataDir: string
const root = () => join(dataDir, 'workspace')
const members: Record<string, string[]> = { R1: ['A'] }
const SECRET_B = 'planted secret of B'
const NOTES_A = 'notes of A'

let records: Array<{ kind: string; actor?: string; via?: string; detail?: unknown }> = []
const audit = {
  record: (entry: (typeof records)[number]) => void records.push(entry),
} as unknown as Pick<Audit, 'record'>
const options: SandboxFilesOptions = {
  dataDir: '',
  audit,
  isRoomMember: (roomId, person) => members[roomId]?.includes(person) === true,
}
const opts = (): SandboxFilesOptions => ({ ...options, dataDir })

const base = { language: 'python', code: 'print(1)' }
const b64 = (text: string) => Buffer.from(text).toString('base64')

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-sbxf-'))
  for (const dir of ['people/A/sandbox', 'people/B', 'rooms/R1', 'rooms/R2', 'keith']) {
    mkdirSync(join(root(), dir), { recursive: true })
  }
  writeFileSync(join(root(), 'people/A/notes.txt'), NOTES_A)
  writeFileSync(join(root(), 'people/B/secret.txt'), SECRET_B)
  writeFileSync(join(root(), 'rooms/R1/plan.md'), 'room plan')
  writeFileSync(join(root(), 'rooms/R2/other.md'), 'other room')
  writeFileSync(join(root(), 'keith/state.json'), 'core state')
  symlinkSync(join(root(), 'people/B'), join(root(), 'people/A/b-link'))
})

afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

describe('a call without files is unchanged', () => {
  test('the input and its outcome pass through as they are', () => {
    const input = { ...base }
    const prepared = prepareCall(opts(), 'A', 'sandbox.run', input)
    expect(prepared).toMatchObject({ ok: true })
    if (!prepared.ok) return
    expect(prepared.input).toBe(input)
    const outcome = { ok: true as const, output: { stdout: '1' } }
    expect(prepared.finish(outcome)).toBe(outcome)
    expect(records).toEqual([])
  })

  test('another capability is never touched', () => {
    const input = { command: 'ls', files: [{ ref: 'people/B/secret.txt', name: 'x' }] }
    const prepared = prepareCall(opts(), 'A', 'shell.exec', input)
    expect(prepared).toMatchObject({ ok: true, input })
  })
})

describe('the files of a call', () => {
  test("the person's own file goes to the node as base64, and the send is audited by path and size", () => {
    records = []
    const prepared = prepareCall(opts(), 'A', 'sandbox.run', {
      ...base,
      files: [{ ref: 'notes.txt', name: 'in.txt' }],
    })
    expect(prepared).toMatchObject({
      ok: true,
      input: { ...base, files: [{ name: 'in.txt', data: b64(NOTES_A) }] },
    })
    expect(records).toEqual([
      {
        kind: 'workspace.file.send',
        actor: 'A',
        via: 'local',
        detail: { person: 'A', path: 'people/A/notes.txt', bytes: NOTES_A.length },
      },
    ])
    // the audit row names the path and the size, never the content
    expect(JSON.stringify(records)).not.toContain(NOTES_A)
  })

  test('a room file is sent only for a member of the room', () => {
    expect(
      prepareCall(opts(), 'A', 'sandbox.run', {
        ...base,
        files: [{ ref: 'rooms/R1/plan.md', name: 'p' }],
      }),
    ).toMatchObject({ ok: true })
    const refused = prepareCall(opts(), 'A', 'sandbox.run', {
      ...base,
      files: [{ ref: 'rooms/R2/other.md', name: 'p' }],
    })
    expect(refused).toMatchObject({
      ok: false,
      message: expect.stringContaining('rooms/R2/other.md'),
    })
  })

  test.each([
    ["another person's file", 'people/B/secret.txt'],
    ['a path out of the folder', '../B/secret.txt'],
    ['keith/', 'keith/state.json'],
    ['a symlink into another folder', 'b-link/secret.txt'],
    ['an absolute path', '/etc/passwd'],
  ])('%s is refused before anything is sent, and nothing is audited', (_label, ref) => {
    records = []
    const prepared = prepareCall(opts(), 'A', 'sandbox.run', {
      ...base,
      files: [{ ref, name: 'x' }],
    })
    expect(prepared).toMatchObject({ ok: false, message: expect.stringContaining(ref) })
    expect(JSON.stringify(prepared)).not.toContain(SECRET_B)
    expect(records).toEqual([])
  })

  test('with no person or no workspace the files are refused', () => {
    expect(
      prepareCall(opts(), undefined, 'sandbox.run', {
        ...base,
        files: [{ ref: 'notes.txt', name: 'x' }],
      }),
    ).toMatchObject({ ok: false, message: 'files need a person with a workspace' })
    expect(
      prepareCall(undefined, 'A', 'sandbox.run', {
        ...base,
        files: [{ ref: 'notes.txt', name: 'x' }],
      }),
    ).toMatchObject({ ok: false })
  })
})

describe('the outputs of a call', () => {
  const report = b64('a,b\n1,2\n')

  test('a returned file lands in the own sandbox folder; the model gets names and sizes, never the bytes', () => {
    const prepared = prepareCall(opts(), 'A', 'sandbox.run', {
      ...base,
      outputFiles: ['report.csv', 'gone.txt'],
    })
    if (!prepared.ok) throw new Error('prepare refused')
    const result = prepared.finish({
      ok: true,
      output: {
        stdout: 'done',
        exitCode: 0,
        files: [{ name: 'report.csv', data: report }],
        missing: [],
      },
    })
    expect(result).toEqual({
      ok: true,
      output: {
        stdout: 'done',
        exitCode: 0,
        saved: [{ name: 'report.csv', path: 'people/A/sandbox/report.csv', bytes: 8 }],
        missing: ['gone.txt'],
      },
    })
    expect(readFileSync(join(root(), 'people/A/notes.txt'), 'utf8')).toBe(NOTES_A)
  })

  test('a name the call did not ask for is dropped, and a link out of the folder writes nothing', () => {
    // A's sandbox folder is a link into B's for this test only: an output must never reach B's folder
    const sandbox = join(root(), 'people/A/sandbox')
    rmSync(sandbox, { recursive: true, force: true })
    mkdirSync(join(root(), 'people/B/sandbox'), { recursive: true })
    symlinkSync(join(root(), 'people/B/sandbox'), sandbox)
    try {
      const prepared = prepareCall(opts(), 'A', 'sandbox.run', { ...base, outputFiles: ['x.txt'] })
      if (!prepared.ok) throw new Error('prepare refused')
      const result = prepared.finish({
        ok: true,
        output: {
          files: [
            { name: 'unasked.txt', data: report },
            { name: 'x.txt', data: report },
          ],
        },
      })
      expect(result).toMatchObject({ ok: true, output: { saved: [], missing: ['x.txt'] } })
      expect(existsSync(join(root(), 'people/B/sandbox/x.txt'))).toBe(false)
      expect(existsSync(join(root(), 'people/B/sandbox/unasked.txt'))).toBe(false)
    } finally {
      rmSync(sandbox, { force: true })
      mkdirSync(sandbox, { recursive: true })
    }
  })

  test('an outcome that failed is handed back unchanged', () => {
    const prepared = prepareCall(opts(), 'A', 'sandbox.run', { ...base, outputFiles: ['a.txt'] })
    if (!prepared.ok) throw new Error('prepare refused')
    const failure = { ok: false as const, code: 'failed' as const, message: 'boom' }
    expect(prepared.finish(failure)).toBe(failure)
  })
})

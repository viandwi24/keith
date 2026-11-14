// The `document_save` tool (P33.4.3, docs/specs/prefrontal.md "Document hand-off"): a long result is saved under the caller's own
// `workspace/people/<id>/documents/`; the person comes from the turn's principal only; a symlink, a `..` or a folder that is not the
// person's own is refused; the file name is a slug and an existing file is never overwritten.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessContext } from 'eharness'
import { resolvePlugin } from 'eharness/testing'
import { personWorkspaceDir, workspaceDir } from '../../platform/workspace-paths.ts'
import {
  createDocumentPlugin,
  DOCUMENT_PLUGIN,
  DOCUMENT_SAVE_TOOL,
  DOCUMENT_SAVED_MESSAGE,
  type DocumentError,
  DocumentSaveInput,
  documentToolOf,
  saveDocument,
  slugOf,
} from './document-tool.ts'

type Exec = { execute: (input: unknown, options: unknown) => Promise<unknown> }
type Answer = { ok: boolean; path?: string; reason?: string; message: string }
const OPTIONS = { toolCallId: 't1', messages: [], abortSignal: new AbortController().signal }
const NOW = new Date(2026, 10, 11, 9, 30)

let dir: string
let outside: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keith-documents-'))
  outside = mkdtempSync(join(tmpdir(), 'keith-documents-outside-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

/** The turn context of a front session for `principal` (undefined: a turn with no principal). */
const ctxOf = (principal?: string): HarnessContext =>
  ({
    session: { id: `front:${principal ?? 'none'}` },
    ...(principal === undefined ? {} : { principal: { id: principal } }),
  }) as unknown as HarnessContext

const toolFor = (principal?: string) =>
  documentToolOf({ dataDir: dir, now: () => NOW })(ctxOf(principal)) as unknown as Exec

const save = (principal: string | undefined, title: string, body: string) =>
  toolFor(principal).execute(DocumentSaveInput.parse({ title, body }), OPTIONS) as Promise<Answer>

/** A body of `n` characters that reads as prose. */
const prose = (n: number) =>
  'The list has one more line of plain text. '.repeat(Math.ceil(n / 46)).slice(0, n)

describe('document_save: the person’s own documents folder', () => {
  test('a 2,000-character result is saved under the caller’s documents/ and the path is relative', async () => {
    const body = prose(2000)
    const answer = await save('ana', 'Full list of flights', body)
    expect(answer.ok).toBe(true)
    expect(answer.path).toBe('documents/2026-11-11-full-list-of-flights.md')
    expect(answer.message).toBe(DOCUMENT_SAVED_MESSAGE)
    const file = join(personWorkspaceDir(dir, 'ana'), answer.path ?? '')
    const text = readFileSync(file, 'utf8')
    expect(text.startsWith('# Full list of flights\n\n')).toBe(true)
    expect(text).toContain(body.trimEnd())
  })

  test('the file lands only in the caller’s folder: another person’s folder and the room folder stay empty', async () => {
    await save('ana', 'Plan', prose(300))
    expect(existsSync(join(personWorkspaceDir(dir, 'bob'), 'documents'))).toBe(false)
    expect(existsSync(join(workspaceDir(dir), 'rooms'))).toBe(false)
  })

  test('a turn with no principal saves nothing', async () => {
    const answer = await save(undefined, 'Plan', prose(300))
    expect(answer.ok).toBe(false)
    expect(answer.reason).toBe('no-person')
    expect(existsSync(workspaceDir(dir))).toBe(false)
  })

  test('a principal id that cannot name a folder is refused, nothing is written under rooms/', async () => {
    for (const id of ['../rooms/x', 'a/b', '..']) {
      const answer = await save(id, 'Plan', prose(300))
      expect(answer.ok).toBe(false)
      expect(answer.reason).toBe('no-workspace')
    }
    expect(existsSync(join(workspaceDir(dir), 'rooms'))).toBe(false)
  })

  test('a symlink as the documents folder is refused and nothing is written outside', async () => {
    const personDir = personWorkspaceDir(dir, 'ana')
    mkdirSync(personDir, { recursive: true })
    symlinkSync(outside, join(personDir, 'documents'))
    const answer = await save('ana', 'Plan', prose(300))
    expect(answer.ok).toBe(false)
    expect(answer.reason).toBe('symlink')
    expect(readdirSync(outside)).toEqual([])
  })

  test('a symlink as the person folder is refused', () => {
    const personDir = join(dir, 'linked-person')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, personDir)
    let reason: string | undefined
    try {
      saveDocument(personDir, { title: 'Plan', body: 'x' }, NOW)
    } catch (error) {
      reason = (error as DocumentError).reason
    }
    expect(reason).toBe('symlink')
    expect(readdirSync(outside)).toEqual([])
  })

  test('a title with ".." or separators cannot leave the documents folder', async () => {
    const answer = await save('ana', '../../../etc/passwd', prose(300))
    expect(answer.ok).toBe(true)
    expect(answer.path).toBe('documents/2026-11-11-etc-passwd.md')
    expect(lstatSync(join(personWorkspaceDir(dir, 'ana'), answer.path ?? '')).isFile()).toBe(true)
  })

  test('the same title twice on one day keeps both files', async () => {
    const first = await save('ana', 'Plan', 'one')
    const second = await save('ana', 'Plan', 'two')
    expect(first.path).toBe('documents/2026-11-11-plan.md')
    expect(second.path).toBe('documents/2026-11-11-plan-2.md')
    expect(readFileSync(join(personWorkspaceDir(dir, 'ana'), first.path ?? ''), 'utf8')).toContain(
      'one',
    )
  })

  test('the slug is ASCII, lowercase, never empty', () => {
    expect(slugOf('Rencana Perjalanan: Bali!')).toBe('rencana-perjalanan-bali')
    expect(slugOf('Café Résumé')).toBe('cafe-resume')
    expect(slugOf('***')).toBe('document')
  })

  test('the plugin offers the tool to the front agent and names it document_save', async () => {
    const resolved = await resolvePlugin(createDocumentPlugin({ dataDir: dir }))
    expect(resolved.name).toBe(DOCUMENT_PLUGIN)
    expect(Object.keys(resolved.tools)).toEqual([DOCUMENT_SAVE_TOOL])
  })
})

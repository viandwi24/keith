// The `document_save` tool of the front agent (docs/specs/prefrontal.md "Document hand-off"; ADR-0029 §5). A long result of a
// personal chat is written to the person's own workspace, `workspace/people/<personId>/documents/<date>-<slug>.md`. The folder comes
// from the cortex workspace resolver (`workspaceOf`), which takes the person from `ctx.principal` only and refuses an id that cannot
// name a folder. The room workspace is never reached from here. A symlink on the way is refused, and the file name is a slug, so a
// `..` in the title cannot leave the folder.
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { type Tool, tool } from 'ai'
import { definePlugin, type HarnessContext, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import { workspaceOf } from '../cortex/index.ts'

export const DOCUMENT_SAVE_TOOL = 'document_save'
export const DOCUMENT_PLUGIN = 'keith-prefrontal-documents'
/** The folder of documents inside a person's workspace. */
export const DOCUMENTS_DIR = 'documents'
export const DOCUMENT_TITLE_MAX = 120
export const DOCUMENT_BODY_MAX = 200_000
/** A file name is tried this many times (`-2`, `-3`, ...) before the save is refused. */
const NAME_TRIES = 100

export const DocumentSaveInput = z.object({
  title: z.string().min(1).max(DOCUMENT_TITLE_MAX),
  body: z.string().min(1).max(DOCUMENT_BODY_MAX),
})

/** What the tool answers. A refusal is an answer, so the model can tell the person what happened. */
export type DocumentSaveAnswer =
  | { ok: true; path: string; message: string }
  | { ok: false; reason: string; message: string }

/** Why a save was refused; the reason is a stable word for the answer. */
export class DocumentError extends Error {
  constructor(
    readonly reason: 'symlink' | 'not-a-folder' | 'too-many-names' | 'outside-folder',
    message: string,
  ) {
    super(message)
    this.name = 'DocumentError'
  }
}

export const DOCUMENT_SAVED_MESSAGE =
  'Saved the text as a document in the person\'s own workspace. Reply with one sentence that offers the file name, for example: "I saved the full list as a document. Want me to send you the file name?"'

/** A lowercase ASCII slug of a title, never empty and never with a dot or a separator. */
export function slugOf(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return slug === '' ? 'document' : slug
}

/** The local date of `now` as `YYYY-MM-DD`. */
export function dateStampOf(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Whether a path exists as itself (a dangling symlink counts as existing). */
function entryOf(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

/**
 * Writes one document under `<personDir>/documents/` and returns its path relative to `personDir`. `personDir` must be the
 * resolver's folder of the person; nothing else is written. A symlink as the person folder or as the documents folder is
 * refused, and an existing file is never overwritten (a free name is taken with `-2`, `-3`, ...).
 */
export function saveDocument(
  personDir: string,
  input: { title: string; body: string },
  now: Date,
): string {
  const person = entryOf(personDir)
  if (person?.isSymbolicLink()) throw new DocumentError('symlink', 'the person folder is a symlink')
  const folder = join(personDir, DOCUMENTS_DIR)
  const docs = entryOf(folder)
  if (docs?.isSymbolicLink())
    throw new DocumentError('symlink', 'the documents folder is a symlink')
  if (docs !== undefined && !docs.isDirectory())
    throw new DocumentError('not-a-folder', 'documents is not a folder')
  mkdirSync(folder, { recursive: true })
  const base = `${dateStampOf(now)}-${slugOf(input.title)}`
  const content = `# ${input.title.trim()}\n\n${input.body.trimEnd()}\n`
  for (let i = 1; i <= NAME_TRIES; i++) {
    const name = i === 1 ? `${base}.md` : `${base}-${i}.md`
    const file = join(folder, name)
    const rel = relative(personDir, file)
    if (rel.startsWith('..') || rel.split(sep).length !== 2)
      throw new DocumentError('outside-folder', 'the document would leave its folder')
    if (entryOf(file) !== undefined) continue
    try {
      // `wx` never follows or replaces an entry that appeared since the check above
      writeFileSync(file, content, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    return rel.split(sep).join('/')
  }
  throw new DocumentError('too-many-names', 'no free file name for the document')
}

export interface DocumentDeps {
  /** The data folder of the core (`<dataDir>/workspace/people/<personId>/documents/`). */
  dataDir: string
  now?: () => Date
}

/** The tool of one turn: the person is `ctx.principal`, read when the tool runs. */
export function documentToolOf(deps: DocumentDeps) {
  return (ctx: HarnessContext): Tool =>
    tool({
      description:
        "Save a long result of this chat (a full list, a plan, a long answer) as a document in the person's own workspace. Pass a short title and the full body in Markdown. The reply to the person is one sentence that offers the file name; do not paste the body into the chat.",
      inputSchema: DocumentSaveInput,
      metadata: { risk: 'write', source: 'trusted' },
      execute: async ({
        title,
        body,
      }: z.infer<typeof DocumentSaveInput>): Promise<DocumentSaveAnswer> => {
        if (ctx.principal?.id === undefined)
          return { ok: false, reason: 'no-person', message: 'no person is talking in this chat' }
        const dir = workspaceOf(deps.dataDir, ctx)
        if (dir === undefined)
          return {
            ok: false,
            reason: 'no-workspace',
            message: 'this person has no workspace folder',
          }
        try {
          const path = saveDocument(dir, { title, body }, (deps.now ?? (() => new Date()))())
          return { ok: true, path, message: DOCUMENT_SAVED_MESSAGE }
        } catch (error) {
          if (error instanceof DocumentError)
            return { ok: false, reason: error.reason, message: error.message }
          throw error
        }
      },
    })
}

/** Plugin of `document_save`: added to the front agent only (the personal session). Rooms have no such tool. */
export function createDocumentPlugin(deps: DocumentDeps): HarnessPlugin<typeof DOCUMENT_PLUGIN> {
  return definePlugin({
    name: DOCUMENT_PLUGIN,
    setup: () => ({
      tools: { [DOCUMENT_SAVE_TOOL]: documentToolOf(deps) },
    }),
  })
}

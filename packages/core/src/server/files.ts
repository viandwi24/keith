// `/v1/files`: uploads and downloads (docs/contracts/protocol.md#files). Bytes live in
// `KEITH_HOME/files/<file id>`, metadata in the `files` table. Who may read a file:
// docs/architecture/storage.md#files.

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { FILE_MAX_BYTES, type FileDto, FileId, type FileUploadResponse, fileUrl } from '@keith/protocol'
import type { Clock, Ids, Logger, MessageId, PersonId } from '../shared/types.ts'
import type { FileRecord, MessageRecord, Repositories } from '../storage/types.ts'
import { errorResponse } from './responses.ts'

export type FilesApiDeps = {
  repos: Pick<Repositories, 'files' | 'threads' | 'messages'>
  ids: Ids
  clock: Clock
  log: Logger
  /** `KEITH_HOME/files`. Null: the endpoints answer `404 NOT_FOUND` (files not configured). */
  dir: string | null
}

export interface FilesApi {
  upload(req: Request, personId: PersonId): Promise<Response>
  download(rawId: string, personId: PersonId): Promise<Response>
}

/** Room for the multipart framing around the file part. */
const MULTIPART_OVERHEAD = 64 * 1024
const NAME_MAX = 255
const DEFAULT_MIME = 'application/octet-stream'
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(\s*;.*)?$/i
const PAGE = 200

export function createFilesApi(deps: FilesApiDeps): FilesApi {
  const { repos, log } = deps

  return {
    async upload(req, personId) {
      const dir = deps.dir
      if (dir === null) return errorResponse('NOT_FOUND', 'files are not available')
      if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) {
        return errorResponse('INVALID_REQUEST', 'expected multipart/form-data')
      }
      const length = Number(req.headers.get('content-length') ?? '0')
      if (length > FILE_MAX_BYTES + MULTIPART_OVERHEAD) return tooLarge()
      let part: unknown
      try {
        part = (await req.formData()).get('file')
      } catch {
        // Converted into the documented 400 (R-11).
        return errorResponse('INVALID_REQUEST', 'body is not valid multipart/form-data')
      }
      if (!(part instanceof Blob))
        return errorResponse('INVALID_REQUEST', "expected a file part named 'file'")
      if (part.size > FILE_MAX_BYTES) return tooLarge()

      const id = deps.ids.next('fil')
      const record: FileRecord = {
        id,
        name: fileName(part),
        path: id,
        mime: mimeOf(part.type),
        size: part.size,
        ownerPersonId: personId,
        createdAt: deps.clock.now(),
      }
      const target = join(dir, record.path)
      await mkdir(dir, { recursive: true })
      await Bun.write(target, part)
      try {
        await repos.files.create(record)
      } catch (error) {
        await rm(target, { force: true })
        throw error
      }
      log.info('file uploaded', { fileId: id, size: record.size, mime: record.mime })
      const body: FileUploadResponse = { file: toFileDto(record) }
      return Response.json(body)
    },

    async download(rawId, personId) {
      const dir = deps.dir
      const id = FileId.safeParse(rawId)
      // A file the caller may not read looks the same as a missing one.
      const notFound = () => errorResponse('NOT_FOUND', 'file not found')
      if (dir === null || !id.success) return notFound()
      const record = await repos.files.get(id.data)
      if (!record || !(await canReadFile(repos, personId, record))) return notFound()
      const file = Bun.file(join(dir, record.path))
      if (!(await file.exists())) {
        log.error('file bytes missing', { fileId: record.id })
        return notFound()
      }
      return new Response(file, {
        headers: {
          'content-type': record.mime,
          'content-length': String(file.size),
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(record.name)}`,
          // Uploaded bytes are untrusted: never sniffed, and a document opened directly runs sandboxed.
          'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'",
          'cache-control': 'private, no-cache',
        },
      })
    },
  }
}

function tooLarge(): Response {
  return errorResponse('INVALID_REQUEST', `file is larger than ${FILE_MAX_BYTES} bytes`)
}

function fileName(part: Blob): string {
  const raw = part instanceof File ? part.name : ''
  // Keep the last path segment only, without control characters.
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(/\p{Cc}/gu, '').trim()
  return base === '' ? 'file' : base.slice(0, NAME_MAX)
}

function mimeOf(type: string): string {
  return type.length <= NAME_MAX && MIME_PATTERN.test(type) ? type : DEFAULT_MIME
}

export function toFileDto(r: FileRecord): FileDto {
  return { id: r.id, name: r.name, mime: r.mime, size: r.size, createdAt: r.createdAt }
}

/**
 * The read rule (storage.md#files): the owner, or a current participant of a thread where the
 * file is referenced by the owner's own message or by a tool's UI block. A reference typed by
 * someone else grants nothing, so knowing a file id is not enough to read it.
 */
export async function canReadFile(
  repos: Pick<Repositories, 'threads' | 'messages'>,
  personId: PersonId,
  file: FileRecord,
): Promise<boolean> {
  if (file.ownerPersonId === personId) return true
  const url = fileUrl(file.id)
  for (const thread of await repos.threads.listForPerson(personId)) {
    let before: MessageId | undefined
    for (;;) {
      const page = await repos.messages.page({
        threadId: thread.id,
        before,
        limit: PAGE,
        roles: ['user', 'assistant'],
      })
      if (page.messages.some((m) => references(m, url, file.ownerPersonId))) return true
      const oldest = page.messages[0]
      if (!page.hasMore || !oldest) break
      before = oldest.id
    }
  }
  return false
}

function references(m: MessageRecord, url: string, owner: PersonId): boolean {
  if (m.role === 'user') return m.authorPersonId === owner && m.content.includes(url)
  if (m.role === 'assistant') return m.ui?.some((e) => JSON.stringify(e.block).includes(url)) ?? false
  return false
}

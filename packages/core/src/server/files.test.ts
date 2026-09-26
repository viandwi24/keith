import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FILE_MAX_BYTES, FileUploadResponse, fileUrl, HttpErrorBody } from '@keith/protocol'
import type { FileId, MessageId, PersonId } from '../shared/types.ts'
import type { MessageRecord } from '../storage/types.ts'
import { login, personId, startTestServer, type TestServer, threadId } from './test-fakes.ts'

let t: TestServer
let dir: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keith-files-test-'))
  t = await startTestServer({ filesDir: join(dir, 'files') })
})
afterEach(async () => {
  await t.stop()
  rmSync(dir, { recursive: true, force: true })
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 250])
const PEPPER = personId(2)
const HAPPY = personId(3)

function upload(token: string | null, parts: Record<string, Blob | string> = {}): Promise<Response> {
  const form = new FormData()
  for (const [name, value] of Object.entries(parts)) form.append(name, value)
  return fetch(`${t.base}/v1/files`, {
    method: 'POST',
    body: form,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

const download = (id: string, token?: string) =>
  fetch(`${t.base}/v1/files/${id}`, token ? { headers: { authorization: `Bearer ${token}` } } : {})

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status)
  expect(HttpErrorBody.parse(await res.json()).error.code as string).toBe(code)
}

async function addPerson(id: PersonId, username: string) {
  await t.repos.persons.create({
    id,
    name: username,
    username,
    passwordHash: await Bun.password.hash('pw'),
    tier: 'member',
    lastSeenAt: null,
    createdAt: 0,
  })
  return login(t, username, 'pw')
}

async function uploadPng(token: string): Promise<FileId> {
  const res = await upload(token, { file: new File([PNG], 'venue.png', { type: 'image/png' }) })
  expect(res.status).toBe(200)
  return FileUploadResponse.parse(await res.json()).file.id
}

let seq = 100
function message(threadN: number, patch: Partial<MessageRecord>): MessageRecord {
  seq += 1
  const base = {
    id: `msg_${String(seq).padStart(26, '0')}` as MessageId,
    threadId: threadId(threadN),
    nodeId: null,
    modality: 'text' as const,
    meta: null,
    createdAt: seq,
  }
  if (patch.role === 'assistant') {
    return {
      ...base,
      role: 'assistant',
      authorPersonId: null,
      content: '',
      toolCalls: null,
      ui: null,
      ...patch,
    }
  }
  return { ...base, role: 'user', authorPersonId: t.owner.id, content: '', ...patch } as MessageRecord
}

/** A group thread of Tony and Pepper (n = 1). */
async function sharedThread() {
  await t.repos.threads.create(
    {
      id: threadId(1),
      kind: 'group',
      slug: null,
      title: 'Expo',
      ownerPersonId: t.owner.id,
      summary: null,
      createdAt: 1,
      updatedAt: 1,
    },
    [t.owner.id, PEPPER],
  )
}

describe('/v1/files', () => {
  test('401 without a token, for upload and download', async () => {
    await expectError(await upload(null, { file: new File([PNG], 'a.png') }), 401, 'UNAUTHORIZED')
    await expectError(await download('fil_00000000000000000000000001'), 401, 'UNAUTHORIZED')
  })

  test('round trip: bytes, mime and name, stored under the files folder', async () => {
    const token = await login(t)
    const res = await upload(token, { file: new File([PNG], 'venue.png', { type: 'image/png' }) })
    expect(res.status).toBe(200)
    const { file } = FileUploadResponse.parse(await res.json())
    expect(file).toMatchObject({
      name: 'venue.png',
      mime: 'image/png',
      size: PNG.length,
      createdAt: t.clock.now(),
    })
    expect(t.repos.data.files.get(file.id)).toMatchObject({ ownerPersonId: t.owner.id, path: file.id })
    expect(readdirSync(join(dir, 'files'))).toEqual([file.id])

    const got = await download(file.id, token)
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(got.headers.get('x-content-type-options')).toBe('nosniff')
    expect(got.headers.get('content-security-policy')).toContain('sandbox')
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG)
  })

  test('a part without a type is stored as application/octet-stream', async () => {
    const token = await login(t)
    const res = await upload(token, { file: new File([new Uint8Array([1, 2, 3])], 'blob') })
    const { file } = FileUploadResponse.parse(await res.json())
    expect(file.mime).toBe('application/octet-stream')
  })

  test('400 for a missing part, a non-file part, a non-multipart body, or a file over the limit', async () => {
    const token = await login(t)
    await expectError(await upload(token, { other: new File([PNG], 'a.png') }), 400, 'INVALID_REQUEST')
    await expectError(await upload(token, { file: 'just text' }), 400, 'INVALID_REQUEST')
    const json = await fetch(`${t.base}/v1/files`, {
      method: 'POST',
      body: '{}',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    })
    await expectError(json, 400, 'INVALID_REQUEST')
    const big = new File([new Uint8Array(FILE_MAX_BYTES + 1)], 'big.bin')
    await expectError(await upload(token, { file: big }), 400, 'INVALID_REQUEST')
    expect(t.repos.data.files.size).toBe(0)
  })

  test('404 for an unknown or malformed id', async () => {
    const token = await login(t)
    await expectError(await download('fil_00000000000000000000000099', token), 404, 'NOT_FOUND')
    await expectError(await download('nope', token), 404, 'NOT_FOUND')
  })

  test('404 for a file the person cannot see', async () => {
    const tony = await login(t)
    const id = await uploadPng(tony)
    const pepper = await addPerson(PEPPER, 'pepper')
    await expectError(await download(id, pepper), 404, 'NOT_FOUND')
  })

  test('participants of a thread where the owner shared it may read it; others may not', async () => {
    const tony = await login(t)
    const id = await uploadPng(tony)
    const pepper = await addPerson(PEPPER, 'pepper')
    const happy = await addPerson(HAPPY, 'happy')
    await sharedThread()
    await t.repos.messages.append(message(1, { role: 'user', content: `look: ${fileUrl(id)}` }))
    expect((await download(id, pepper)).status).toBe(200)
    await expectError(await download(id, happy), 404, 'NOT_FOUND')
  })

  test('a tool block referencing the file counts; a URL typed by someone else does not', async () => {
    const tony = await login(t)
    const id = await uploadPng(tony)
    const pepper = await addPerson(PEPPER, 'pepper')
    await sharedThread()
    // Pepper pastes the URL herself: that grants her nothing.
    await t.repos.messages.append(
      message(1, { role: 'user', authorPersonId: PEPPER, content: `mine? ${fileUrl(id)}` }),
    )
    await expectError(await download(id, pepper), 404, 'NOT_FOUND')
    await t.repos.messages.append(
      message(1, {
        role: 'assistant',
        content: 'Here it is.',
        ui: [
          {
            block: { type: 'image', id: 'pic', url: fileUrl(id), alt: 'venue' },
            toolCallId: 'c1',
            toolName: 'test.venues',
          },
        ],
      }),
    )
    expect((await download(id, pepper)).status).toBe(200)
  })

  test('references older than one page are found', async () => {
    const tony = await login(t)
    const id = await uploadPng(tony)
    const pepper = await addPerson(PEPPER, 'pepper')
    await sharedThread()
    await t.repos.messages.append(message(1, { role: 'user', content: fileUrl(id) }))
    for (let i = 0; i < 450; i++)
      await t.repos.messages.append(message(1, { role: 'user', content: `m${i}` }))
    expect((await download(id, pepper)).status).toBe(200)
  })
})

describe('/v1/files without a files directory', () => {
  test('answers 404', async () => {
    const s = await startTestServer()
    try {
      const token = await login(s)
      const form = new FormData()
      form.append('file', new File([PNG], 'a.png'))
      const res = await fetch(`${s.base}/v1/files`, {
        method: 'POST',
        body: form,
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(404)
    } finally {
      await s.stop()
    }
  })
})

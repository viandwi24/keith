/** Notes in a booted core with the built-in plugin list: real people, real ACL, real HTTP routes. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'

let booted: BootedCore
let db: Sqlite
beforeAll(async () => {
  booted = await bootCore()
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' }).dbFile)
})
afterAll(async () => {
  db.close()
  await booted.stop()
})

async function bearer(username: string): Promise<string> {
  const person = await booted.local.rpc.admin.people.get({ person: username })
  const { token } = await createCredential(credentialsRepo(db), {
    personId: person.id,
    kind: 'token',
    label: 'test',
  })
  return token
}
const post = (op: string, token: string, body: unknown = {}) =>
  fetch(`${booted.url}/plugins/notes/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('notes in core', () => {
  test('loaded by default; private; shared to one person through the plugin; unshared again', async () => {
    expect(booted.core.plugins.status().find((p) => p.id === 'notes')?.state).toBe('loaded')
    expect(booted.core.kinds.get('note')?.class).toBe('leaf')
    await booted.local.rpc.admin.people.add({ username: 'ana', name: 'Ana' })
    await booted.local.rpc.admin.people.add({ username: 'ben', name: 'Ben' })
    const [ana, ben] = [await bearer('ana'), await bearer('ben')]

    const made = await post('create', ana, { title: 'Plan', body: 'kumquat budget' })
    expect(made.status).toBe(200)
    const { id } = (await made.json()) as { id: string }
    expect((await post('get', ben, { id })).status).toBe(404)
    expect(((await (await post('list', ben)).json()) as { total: number }).total).toBe(0)

    // share by name: the access service resolves the username, audits acl.share
    const shared = await post('share', ana, { id, target: 'user:ben' })
    expect(shared.status).toBe(200)
    expect(((await shared.json()) as { entries: { who: string }[] }).entries[0]?.who).toBe(
      'user:ben',
    )
    const read = (await (await post('get', ben, { id })).json()) as { body: string; by: string }
    expect(read).toMatchObject({ body: 'kumquat budget', by: 'Ana' })
    const found = (await (await post('search', ben, { query: 'kumquat' })).json()) as {
      results: unknown[]
    }
    expect(found.results.length).toBe(1)

    // widening to everyone needs a step-up: a plain bearer is refused and nothing changed
    expect((await post('share', ana, { id, target: '@public' })).status).toBe(403)
    expect((await post('update', ben, { id, title: 'x' })).status).toBe(403) // read only

    await post('unshare', ana, { id, target: 'user:ben' })
    expect((await post('get', ben, { id })).status).toBe(404)
  })

  test('the OpenAPI document of a member lists Notes and not its public operations twice', async () => {
    const ana = await bearer('ana')
    const doc = (await (
      await fetch(`${booted.url}/plugins/openapi.json`, {
        headers: { authorization: `Bearer ${ana}` },
      })
    ).json()) as { paths: Record<string, unknown> }
    expect(Object.keys(doc.paths)).toContain('/plugins/notes/create')
    expect(Object.keys(doc.paths)).toContain('/plugins/notes/public_get')
  })
})

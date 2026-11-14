import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore, FAST_HASH } from './testing/boot-core.ts'

/** An open activity feed ends when its principal stops being valid (docs/specs/thalamus.md). */
let b: BootedCore
let db: Sqlite

beforeAll(async () => {
  b = await bootCore({}, { hasher: FAST_HASH, streamSweepMs: 100 })
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' }).dbFile)
})
afterAll(async () => {
  db.close()
  await b.stop()
})

let counter = 0
/** A person with a PIN (so they can become the owner) and a credential as a TCP client holds it. */
async function person(prefix: string, options: { absoluteMs?: number } = {}) {
  const username = `${prefix}${++counter}x`
  const created = await b.local.rpc.admin.people.add({ username })
  await b.local.rpc.admin.people.setPin({ person: username, pin: '482915' })
  const issued = await credential(created.id, options)
  return { username, personId: created.id, credentialId: issued.id, token: issued.token }
}
async function credential(personId: string, options: { absoluteMs?: number } = {}) {
  return createCredential(credentialsRepo(db), {
    personId,
    kind: 'device',
    label: 'test',
    ...options,
  })
}

interface Feed {
  status: number
  records: string[]
  /** Resolves true when the stream ended, false after `ms` while it is still open. */
  ended(ms: number): Promise<boolean>
  cancel(): void
}
/** Open the activity feed with a bearer and read it in the background. */
async function feed(token: string): Promise<Feed> {
  const ac = new AbortController()
  const res = await fetch(`${b.url}/activity/stream`, {
    headers: { authorization: `Bearer ${token}` },
    signal: ac.signal,
  })
  const records: string[] = []
  let done = false
  const reading = (async () => {
    if (res.body === null) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        records.push(decoder.decode(chunk.value))
      }
    } catch {
      // aborted by the test
    }
    done = true
  })()
  return {
    status: res.status,
    records,
    async ended(ms) {
      await Promise.race([reading, Bun.sleep(ms)])
      return done
    },
    cancel: () => ac.abort(),
  }
}
const reconnect = async (token: string) =>
  (
    await fetch(`${b.url}/activity/stream`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).status
const identityRecords = (f: Feed) =>
  f.records
    .join('')
    .split('\n')
    .filter((l) => l.includes('identity.changed'))

describe('open activity streams', () => {
  test('devices revoke ends the stream of that credential only; the reconnect gets 401', async () => {
    const ana = await person('ana')
    const other = await credential(ana.personId)
    const f = await feed(ana.token)
    const g = await feed(other.token)
    expect(f.status).toBe(200)
    await b.local.rpc.admin.devices.revoke({ id: ana.credentialId })
    expect(await f.ended(1000)).toBe(true)
    expect(await reconnect(ana.token)).toBe(401)
    expect(await g.ended(300)).toBe(false)
    expect(await reconnect(other.token)).toBe(200)
    g.cancel()
  })

  test('suspend ends the person streams, not another person', async () => {
    const ana = await person('sus')
    const bob = await person('bob')
    const f = await feed(ana.token)
    const g = await feed(bob.token)
    await b.local.rpc.admin.people.suspend({ person: ana.username })
    expect(await f.ended(1000)).toBe(true)
    expect(await reconnect(ana.token)).toBe(401)
    expect(await g.ended(300)).toBe(false)
    expect(identityRecords(g)).toEqual([])
    g.cancel()
  })

  test('a grant change ends the stream; the reconnect is served with the new filter', async () => {
    const ana = await person('grant')
    const f = await feed(ana.token)
    await b.local.rpc.admin.people.grant({ person: ana.username, capability: 'tokens.manage' })
    expect(await f.ended(1000)).toBe(true)
    expect(await reconnect(ana.token)).toBe(200)
    const g = await feed(ana.token)
    await b.local.rpc.admin.people.revokeGrant({
      person: ana.username,
      capability: 'tokens.manage',
    })
    expect(await g.ended(1000)).toBe(true)
  })

  test('identity.changed reaches the affected person only', async () => {
    const ana = await person('rec')
    const bob = await person('recb')
    // the affected person reconnects after the change and reads the record from the start
    await b.local.rpc.admin.people.grant({ person: ana.username, capability: 'tokens.manage' })
    const afterGrant = await fetch(`${b.url}/activity/stream?after=0`, {
      headers: { authorization: `Bearer ${ana.token}` },
    })
    const ac = new AbortController()
    const reader = afterGrant.body?.getReader()
    let text = ''
    const deadline = Date.now() + 1500
    while (reader !== undefined && Date.now() < deadline && !text.includes('identity.changed')) {
      const chunk = await Promise.race([reader.read(), Bun.sleep(300).then(() => undefined)])
      if (chunk === undefined) break
      if (chunk.done) break
      text += new TextDecoder().decode(chunk.value)
    }
    await reader?.cancel()
    ac.abort()
    expect(text).toContain('identity.changed')
    expect(text).toContain(ana.personId)
    const bobRes = await fetch(`${b.url}/activity/stream?after=0`, {
      headers: { authorization: `Bearer ${bob.token}` },
    })
    const bobReader = bobRes.body?.getReader()
    let bobText = ''
    const until = Date.now() + 600
    while (bobReader !== undefined && Date.now() < until) {
      const chunk = await Promise.race([bobReader.read(), Bun.sleep(200).then(() => undefined)])
      if (chunk === undefined || chunk.done) break
      bobText += new TextDecoder().decode(chunk.value)
    }
    await bobReader?.cancel()
    expect(bobText).not.toContain(ana.personId)
  })

  test('a credential that ran out ends its stream on the sweep', async () => {
    const ana = await person('exp', { absoluteMs: 600 })
    const f = await feed(ana.token)
    expect(f.status).toBe(200)
    expect(await f.ended(3000)).toBe(true)
    expect(await reconnect(ana.token)).toBe(401)
  })

  test('removing a person ends their stream', async () => {
    const ana = await person('gone')
    const f = await feed(ana.token)
    await b.local.rpc.admin.people.remove({ person: ana.username })
    expect(await f.ended(1000)).toBe(true)
  })

  test('transferOwner ends the stream of the former owner', async () => {
    const owner = await credential('owner')
    const ana = await person('new')
    const f = await feed(owner.token)
    expect(f.status).toBe(200)
    await b.local.rpc.admin.people.transferOwner({ person: ana.username })
    expect(await f.ended(1000)).toBe(true)
    expect(await reconnect(owner.token)).toBe(401)
  })
})

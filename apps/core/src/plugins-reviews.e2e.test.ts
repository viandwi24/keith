/**
 * The owner review queue in a booted core (docs/specs/plugins.md): a member's held operation waits, the owner
 * reads it as data and decides it over the socket, approval replays as the requester, a remote approval needs a
 * step-up, and a suspended requester is refused.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { credentialsRepo, openDatabase, type Sqlite } from '@keith/db'
import { defineKeithPlugin, defineOperation } from '@keith/host'
import { z } from 'zod'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore, stepUp } from './testing/boot-core.ts'

const sent: string[] = []
const remind = defineKeithPlugin({
  id: 'remind',
  version: '1.0.0',
  apiVersion: 1,
  operations: [
    defineOperation({
      name: 'create',
      description: 'Create a reminder for a person.',
      input: z.object({ to: z.string().max(40), text: z.string().max(200) }),
      output: z.object({ ok: z.literal(true) }),
      permission: { capability: 'authenticated' },
      review: { by: 'owner', when: (input, actor) => input.to !== actor.personId },
      run: (input, k) => {
        sent.push(`${k.actor.personId}->${input.to}:${input.text}`)
        return { ok: true as const }
      },
    }),
  ],
})

let booted: BootedCore
let db: Sqlite
beforeAll(async () => {
  booted = await bootCore({}, { plugins: [remind] })
  db = openDatabase(loadConfig({ KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' }).dbFile)
})
afterAll(async () => {
  db.close()
  await booted.stop()
})

async function bearer(person: string): Promise<string> {
  const p = await booted.local.rpc.admin.people.get({ person })
  return (
    await createCredential(credentialsRepo(db), { personId: p.id, kind: 'token', label: 't' })
  ).token
}
const post = (token: string, body: unknown) =>
  fetch(`${booted.url}/plugins/remind/create`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return (e as { code?: string }).code ?? 'error'
  }
}

describe('owner review queue', () => {
  test('a member for someone else waits; for themselves it runs at once', async () => {
    await booted.local.rpc.admin.people.add({ username: 'ana', name: 'Ana' })
    await booted.local.rpc.admin.people.add({ username: 'ben', name: 'Ben' })
    const ana = await bearer('ana')
    const self = await booted.local.rpc.admin.people.get({ person: 'ana' })
    expect((await post(ana, { to: self.id, text: 'mine' })).status).toBe(200)
    const held = await post(ana, { to: 'ben', text: 'please call' })
    expect(held.status).toBe(202)
    expect(await held.json()).toMatchObject({
      review: { status: 'pending', message: 'sent to the owner for review' },
    })
    expect(sent).toEqual([`${self.id}->${self.id}:mine`])
  })

  test('the owner reads it as data; a member cannot read the queue', async () => {
    const [r] = await booted.local.rpc.admin.reviews.list({ status: 'pending' })
    expect(r).toMatchObject({
      plugin: 'remind',
      operation: 'create',
      payload: { to: 'ben', text: 'please call' },
      status: 'pending',
      requester: { username: 'ana' },
    })
    expect(await code(booted.tcp(await bearer('ana')).rpc.admin.reviews.list({}))).toBe('FORBIDDEN')
  })

  test('over TCP the owner needs a step-up to decide; over the socket none', async () => {
    const [r] = await booted.local.rpc.admin.reviews.list({ status: 'pending' })
    const owner = await bearer('owner')
    expect(
      await code(booted.tcp(owner).rpc.admin.reviews.approve({ id: (r as { id: string }).id })),
    ).toBe('KEITH_STEP_UP_REQUIRED')
    expect(sent.length).toBe(1)
  })

  test('approval runs the operation as the requester, once, and is audited without the payload', async () => {
    const [r] = await booted.local.rpc.admin.reviews.list({ status: 'pending' })
    const id = (r as { id: string }).id
    const done = await booted.local.rpc.admin.reviews.approve({ id })
    expect(done).toMatchObject({ status: 'approved', outcome: 'ok', decidedBy: 'owner' })
    const ana = await booted.local.rpc.admin.people.get({ person: 'ana' })
    expect(sent[1]).toBe(`${ana.id}->ben:please call`)
    expect(await code(booted.local.rpc.admin.reviews.approve({ id }))).toBe('CONFLICT')
    const audit = await booted.local.rpc.admin.audit.list({ limit: 50 })
    const kinds = audit.map((a) => a.kind)
    expect(kinds).toContain('plugin.remind.review.requested')
    expect(kinds).toContain('plugin.review.approved')
    expect(JSON.stringify(audit)).not.toContain('please call')
  })

  test('a suspended requester cannot be approved (the review stays pending); the owner denies it with a reason', async () => {
    const ana = await bearer('ana')
    await post(ana, { to: 'ben', text: 'second' })
    const [r] = await booted.local.rpc.admin.reviews.list({ status: 'pending' })
    const id = (r as { id: string }).id
    await booted.local.rpc.admin.people.suspend({ person: 'ana' })
    expect(await code(booted.local.rpc.admin.reviews.approve({ id }))).toBe('CONFLICT')
    expect((await booted.local.rpc.admin.reviews.list({ status: 'pending' })).length).toBe(1)
    const denied = await booted.local.rpc.admin.reviews.deny({ id, reason: 'not now' })
    expect(denied).toMatchObject({ status: 'denied', reason: 'not now' })
    expect(sent.length).toBe(2)
  })

  test('a stepped-up owner session may decide over TCP', async () => {
    await booted.local.rpc.admin.people.reactivate({ person: 'ana' })
    const ana = await bearer('ana')
    await post(ana, { to: 'ben', text: 'third' })
    const owner = await bearer('owner')
    await stepUp(booted, owner)
    const [r] = await booted.local.rpc.admin.reviews.list({ status: 'pending' })
    expect(
      await code(booted.tcp(owner).rpc.admin.reviews.deny({ id: (r as { id: string }).id })),
    ).toBe('ok')
  })
})

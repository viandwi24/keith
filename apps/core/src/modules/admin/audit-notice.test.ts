import { afterAll, describe, expect, test } from 'bun:test'
import { AUDIT_PRIVACY_NOTICE_TEXT } from '@keith/contracts'
import { credentialsRepo, openDatabase } from '@keith/db'
import { loadConfig } from '../../platform/config.ts'
import { type BootedCore, bootCore, FAST_HASH } from '../../testing/boot-core.ts'
import { createCredential } from '../auth/index.ts'

let b: BootedCore | undefined
afterAll(async () => {
  await b?.stop().catch(() => undefined)
})

describe('audit.notice (the first-login notice)', () => {
  test('each person sees it unseen once; an ack is recorded once; a second device sees it as seen', async () => {
    b = await bootCore({}, { hasher: FAST_HASH })
    const db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' }).dbFile)
    const as = async (username: string) => {
      const p = await (b as BootedCore).local.rpc.admin.people.add({ username })
      const { token } = await createCredential(credentialsRepo(db), {
        personId: p.id,
        kind: 'token',
        label: 'phone',
      })
      const { token: second } = await createCredential(credentialsRepo(db), {
        personId: p.id,
        kind: 'token',
        label: 'laptop',
      })
      return {
        person: p,
        phone: (b as BootedCore).tcp(token),
        laptop: (b as BootedCore).tcp(second),
      }
    }
    const ana = await as('ana')
    const ben = await as('ben')
    const first = await ana.phone.rpc.admin.audit.notice.get()
    expect(first).toEqual({ notice: 'audit-privacy', text: AUDIT_PRIVACY_NOTICE_TEXT, seen: false })
    expect(first.text).toContain('Manage > Privacy')
    await ana.phone.rpc.admin.audit.notice.ack()
    await ana.phone.rpc.admin.audit.notice.ack()
    // another device of the same person, and the second ack, change nothing
    expect((await ana.laptop.rpc.admin.audit.notice.get()).seen).toBe(true)
    await ana.laptop.rpc.admin.audit.notice.ack()
    // another person is unaffected
    expect((await ben.phone.rpc.admin.audit.notice.get()).seen).toBe(false)
    // the owner is told once as well (it explains the rule they enforce)
    expect((await (b as BootedCore).local.rpc.admin.audit.notice.get()).seen).toBe(false)
    await (b as BootedCore).local.rpc.admin.audit.notice.ack()
    expect((await (b as BootedCore).local.rpc.admin.audit.notice.get()).seen).toBe(true)
    const rows = (await (b as BootedCore).local.rpc.admin.audit.list({ limit: 200 })).filter(
      (e) => e.kind === 'person.notice.seen',
    )
    expect(rows.map((r) => r.detail.subject).sort()).toEqual([ana.person.id, 'owner'].sort())
    expect(rows.every((r) => r.detail.notice === 'audit-privacy')).toBe(true)
    // it is on record for the owner, and it is not a line the member needs in Privacy
    const mine = await ana.phone.rpc.admin.audit.mine({})
    expect(mine.some((l) => l.kind === 'person.notice.seen')).toBe(false)
    db.close()
  })
})

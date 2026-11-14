import { describe, expect, test } from 'bun:test'
import { ACL_AUDIT_KINDS } from '@keith/contracts'
import { auditRepo, migrateDatabase, openDatabase } from '@keith/db'
import { createAclAudit } from './acl-audit.ts'
import { createAudit } from './audit.ts'

const MIN = 60_000
const boss = { by: 'boss', via: 'tcp' as const, session: 'sess-1' }

function setup() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  let t = 1_800_000_000_000
  const repo = auditRepo(sqlite, { now: () => t })
  const warnings: string[] = []
  const acl = createAclAudit({
    audit: createAudit(repo),
    now: () => t,
    warn: (m) => warnings.push(m),
  })
  return {
    acl,
    warnings,
    advance: (ms: number) => {
      t += ms
    },
    rows: () => repo.list(100).reverse(),
  }
}

describe('owner access', () => {
  test('one row per session and resource per 10 minutes, with no content', () => {
    const { acl, rows, advance } = setup()
    const one = { kind: 'note', bits: 4, resources: [{ id: 'n1', owner: 'duta' }] }
    expect(acl.ownerAccess(boss, one)).toBe(1)
    expect(acl.ownerAccess(boss, one)).toBe(0)
    advance(9 * MIN)
    expect(acl.ownerAccess(boss, one)).toBe(0)
    advance(2 * MIN)
    expect(acl.ownerAccess(boss, one)).toBe(1)
    const all = rows()
    expect(all.map((r) => r.kind)).toEqual(['acl.owner-access', 'acl.owner-access'])
    expect(all[0]).toMatchObject({
      actor: 'boss',
      via: 'tcp',
      detail: { kind: 'note', id: 'n1', owner: 'duta', bits: 4 },
    })
  })

  test('another session or another resource is its own row', () => {
    const { acl } = setup()
    const a = { kind: 'note', bits: 4, resources: [{ id: 'n1', owner: 'duta' }] }
    expect(acl.ownerAccess(boss, a)).toBe(1)
    expect(acl.ownerAccess({ ...boss, session: 'sess-2' }, a)).toBe(1)
    expect(acl.ownerAccess(boss, { ...a, resources: [{ id: 'n2', owner: 'duta' }] })).toBe(1)
    expect(acl.ownerAccess(boss, { ...a, kind: 'reminder' })).toBe(1)
  })

  test('a search that touches 50 notes is one row per owner, not 50; the repeat writes none', () => {
    const { acl, rows } = setup()
    const resources = Array.from({ length: 50 }, (_, i) => ({
      id: `n${i}`,
      owner: i % 2 === 0 ? 'duta' : 'amel',
    }))
    const search = { kind: 'note', bits: 4, resources }
    expect(acl.ownerAccess(boss, search)).toBe(2)
    expect(acl.ownerAccess(boss, search)).toBe(0)
    const all = rows()
    expect(all).toHaveLength(2)
    const duta = all.find((r) => r.detail.owner === 'duta')
    expect(duta?.detail.count).toBe(25)
    expect(((duta?.detail.ids ?? []) as string[]).length).toBe(20)
    // a new note appearing in a later search adds a row for that one only
    expect(
      acl.ownerAccess(boss, {
        kind: 'note',
        bits: 4,
        resources: [...resources, { id: 'n99', owner: 'duta' }],
      }),
    ).toBe(1)
    expect(rows().at(-1)?.detail).toMatchObject({ id: 'n99', owner: 'duta' })
  })

  test('the session falls back to the person when there is none', () => {
    const { acl } = setup()
    const r = { kind: 'note', bits: 4, resources: [{ id: 'n1', owner: 'duta' }] }
    expect(acl.ownerAccess({ by: 'boss', via: 'local' }, r)).toBe(1)
    expect(acl.ownerAccess({ by: 'boss', via: 'local', session: null }, r)).toBe(0)
  })
})

describe('denied reads are counted, not logged one by one', () => {
  test('one row per window; the next window reports what was held back', () => {
    const { acl, rows, advance } = setup()
    const me = { by: 'mia', via: 'tcp' as const, session: 's' }
    for (let i = 0; i < 40; i++) acl.denied(me, 'note')
    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.detail).toEqual({ kind: 'note', count: 1, suppressed: 0 })
    advance(11 * MIN)
    acl.denied(me, 'note')
    expect(rows()).toHaveLength(2)
    expect(rows()[1]?.detail).toEqual({ kind: 'note', count: 1, suppressed: 39 })
  })

  test('flush writes the held-back count of an open window', () => {
    const { acl, rows } = setup()
    const me = { by: 'mia', via: 'tcp' as const, session: 's' }
    for (let i = 0; i < 5; i++) acl.denied(me, 'note')
    acl.denied(me, 'reminder')
    acl.flush()
    const all = rows()
    expect(all).toHaveLength(3) // note, reminder, and the note summary
    expect(all[2]?.detail).toEqual({ kind: 'note', count: 5, suppressed: 4 })
    acl.flush()
    expect(rows()).toHaveLength(3)
  })
})

describe('change events', () => {
  test('every kind records its fixed fields, and a stray key (a title, a body, a secret) is dropped', () => {
    const { acl, rows } = setup()
    const by = { by: 'olga', via: 'local' as const }
    acl.record('acl.create', by, {
      kind: 'note',
      id: 'n1',
      owner: 'olga',
      mode: 0o600,
      title: 'my diary',
      body: 'secret text',
    })
    acl.record('acl.share', by, {
      kind: 'note',
      id: 'n1',
      subject: 'user:duta',
      bits: 4,
      effect: 'allow',
      content: 'x',
    })
    acl.record('acl.unshare', by, { kind: 'note', id: 'n1', subject: 'user:duta', effect: 'allow' })
    acl.record('acl.chmod', by, { kind: 'note', id: 'n1', from: 0o600, to: 0o640 })
    acl.record('acl.chown', by, { kind: 'note', id: 'n1', from: 'olga', to: 'duta' })
    acl.record('acl.remove', by, { kind: 'note', id: 'n1' })
    acl.record('acl.group.create', by, { group: 'g1', name: 'friends' })
    acl.record('acl.group.add', by, { group: 'g1', person: 'duta' })
    acl.record('acl.group.remove', by, { group: 'g1', person: 'duta' })
    acl.record('acl.group.delete', by, { group: 'g1', name: 'friends' })
    const all = rows()
    expect(all.map((r) => r.kind)).toEqual([
      'acl.create',
      'acl.share',
      'acl.unshare',
      'acl.chmod',
      'acl.chown',
      'acl.remove',
      'acl.group.create',
      'acl.group.add',
      'acl.group.remove',
      'acl.group.delete',
    ])
    const text = JSON.stringify(all)
    expect(text).not.toContain('diary')
    expect(text).not.toContain('secret text')
    expect(all[0]?.detail).toEqual({ kind: 'note', id: 'n1', owner: 'olga', mode: 0o600 })
    expect(all.every((r) => r.actor === 'olga' && r.via === 'local')).toBe(true)
  })

  test('a malformed detail is recorded as invalid with nothing from it, and warns', () => {
    const { acl, rows, warnings } = setup()
    acl.record(
      'acl.share',
      { by: 'olga', via: 'local' },
      { kind: 'note', id: 'n1', subject: 'user:duta', bits: 99, effect: 'allow', body: 'secret' },
    )
    expect(rows()[0]?.detail).toEqual({ invalid: true })
    expect(warnings).toHaveLength(1)
    expect(JSON.stringify(rows())).not.toContain('secret')
  })

  test('the kinds written here are exactly the contract kinds', () => {
    expect(new Set(ACL_AUDIT_KINDS).size).toBe(13)
  })
})

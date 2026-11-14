import { afterAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AUDIT_SUBJECT_FIELDS } from '@keith/contracts'
import { auditRepo, credentialsRepo, migrateDatabase, openDatabase } from '@keith/db'
import { loadConfig } from '../../platform/config.ts'
import { type BootedCore, bootCore, FAST_HASH } from '../../testing/boot-core.ts'
import { createCredential } from '../auth/index.ts'
import { hiddenMineKinds, listMine, mySummaryKinds, subjectKinds } from './mine.ts'

const booted: BootedCore[] = []
afterAll(async () => {
  for (const b of booted) await b.stop().catch(() => undefined)
})

describe('audit.mine registry', () => {
  test('every kind with a subject has a summary or is listed as hidden, and nothing else is registered', () => {
    const kinds = Object.keys(AUDIT_SUBJECT_FIELDS).sort()
    const covered = [...mySummaryKinds(), ...hiddenMineKinds()].sort()
    expect(covered).toEqual(kinds)
  })

  test('a person.* or credential.* kind written by the core is in the registry', () => {
    const root = join(import.meta.dir, '../..')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path)
      }
    }
    walk(root)
    const written = new Set<string>()
    for (const file of files)
      for (const m of readFileSync(file, 'utf8').matchAll(/'((?:person|credential)\.[a-z.]+)'/g))
        if (m[1] !== undefined && !m[1].endsWith('.')) written.add(m[1])
    // person events of the store (`person.<event>`) are written with a template, so they are listed here
    const missing = [...written].filter((k) => AUDIT_SUBJECT_FIELDS[k] === undefined)
    expect(missing).toEqual([])
  })
})

describe('admin.audit.mine', () => {
  test('a member reads lines about themselves, never another person, an address or the listener', async () => {
    const b = await bootCore({}, { hasher: FAST_HASH })
    booted.push(b)
    const db = openDatabase(loadConfig({ KEITH_DATA_DIR: b.dir, KEITH_BUILD_SHA: 'test' }).dbFile)
    const local = b.local.rpc.admin
    await local.people.add({ username: 'ana' })
    await local.people.add({ username: 'ben' })
    const ana = await local.people.get({ person: 'ana' })
    const ben = await local.people.get({ person: 'ben' })
    await local.people.setPassword({
      person: 'ana',
      password: ['pass', 'phrase', 'long', 'one'].join(' '),
    })
    await local.people.setPassword({
      person: 'ben',
      password: ['pass', 'phrase', 'long', 'two'].join(' '),
    })
    // the owner looks at a note of Ana and of Ben (what `acl.owner-access` is)
    const audit = auditRepo(db)
    audit.add({
      kind: 'acl.owner-access',
      actor: 'owner',
      via: 'tcp',
      detail: { kind: 'note', id: 'n1', owner: ana.id, bits: 4, ip: '10.0.0.9' },
    })
    audit.add({
      kind: 'acl.owner-access',
      actor: 'owner',
      via: 'tcp',
      detail: { kind: 'note', id: 'n2', owner: ben.id, bits: 4 },
    })
    const { token } = await createCredential(credentialsRepo(db), {
      personId: ana.id,
      kind: 'token',
      label: 'test',
    })
    const mine = await b.tcp(token).rpc.admin.audit.mine({})
    const kinds = mine.map((l) => l.kind)
    expect(kinds).toContain('acl.owner-access')
    expect(kinds).toContain('person.secret.set')
    expect(mine.find((l) => l.kind === 'acl.owner-access')).toMatchObject({
      summary: 'looked at one of your notes',
      actorName: 'Owner',
      resource: { kind: 'note', id: 'n1' },
    })
    const text = JSON.stringify(mine)
    expect(text).not.toContain(ben.id)
    expect(text).not.toContain('n2')
    for (const line of mine) expect(Object.keys(line).sort()).not.toContain('via')
    expect(text).not.toContain('"ip"')
    // the owner can read another person's lines; a member cannot
    const asOwner = await b.local.rpc.admin.audit.mine({ person: 'ben' })
    expect(asOwner.some((l) => l.resource?.id === 'n2')).toBe(true)
    await expect(b.tcp(token).rpc.admin.audit.mine({ person: 'ben' })).rejects.toThrow(
      /only the owner/,
    )
    // and a member with no grant still cannot read the whole log
    await expect(b.tcp(token).rpc.admin.audit.list({})).rejects.toThrow()
    db.close()
  })
})

describe('protocol runs in audit.mine', () => {
  test('every protocol kind the engine writes names its subject and has a line for the person', () => {
    const kinds = [
      'protocol.run.start',
      'protocol.run.step',
      'protocol.run.end',
      'protocol.run.refused',
      'protocol.act',
      'protocol.proposal.create',
      'protocol.proposal.confirm',
      'protocol.proposal.dismiss',
      'protocol.answer',
    ]
    for (const kind of kinds) {
      expect(subjectKinds()).toContain(kind)
      expect(mySummaryKinds()).toContain(kind)
    }
  })
})

describe('audit.mine lines of the persona and the reply style (P33.2.5)', () => {
  test('a style change names the fields only; the owner change is listed for each member and carries no text', () => {
    const db = openDatabase(':memory:')
    migrateDatabase(db)
    const repo = auditRepo(db)
    repo.add({
      kind: 'persona.style.set',
      actor: 'ana',
      via: 'tcp',
      detail: { subject: 'ana', fields: ['brevity', 'gentleTopics'] },
    })
    repo.add({
      kind: 'persona.change',
      actor: 'boss',
      via: 'tcp',
      detail: { version: 2, reason: 'edit', templateId: 'custom', members: ['boss', 'ana', 'bob'] },
    })
    const names = (id: string) => id
    const ana = listMine(repo, 'ana', {}, names)
    expect(ana.map((line) => line.summary)).toEqual([
      "the owner changed Keith's persona",
      'changed how Keith replies to you (brevity, gentleTopics)',
    ])
    const bob = listMine(repo, 'bob', {}, names)
    expect(bob.map((line) => line.kind)).toEqual(['persona.change'])
    expect(listMine(repo, 'cy', {}, names)).toEqual([])
    const shown = JSON.stringify(ana)
    expect(shown).not.toContain('custom')
    expect(shown).not.toContain('"version"')
    db.close()
  })
})

describe('audit.mine lines of the removed client-context switch (history only)', () => {
  test('an old settings.client-context row still reads in Privacy, with its summary for on and off', () => {
    const db = openDatabase(':memory:')
    migrateDatabase(db)
    const repo = auditRepo(db)
    repo.add({
      kind: 'settings.client-context',
      actor: 'ana',
      via: 'tcp',
      detail: { subject: 'ana', share: false },
    })
    repo.add({
      kind: 'settings.client-context',
      actor: 'ana',
      via: 'tcp',
      detail: { subject: 'ana', share: true },
    })
    const lines = listMine(repo, 'ana', {}, (id) => id)
    expect(lines.map((line) => line.summary)).toEqual([
      'turned on sharing of your app, device, network and time zone with Keith',
      'turned off sharing of your app, device, network and time zone with Keith',
    ])
    expect(lines.every((line) => line.kind === 'settings.client-context')).toBe(true)
    db.close()
  })
})

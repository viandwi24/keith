import { describe, expect, test } from 'bun:test'
import { type PersonaBody, PersonaBodySchema } from '@keith/contracts'
import { migrateDatabase, openDatabase } from '../connection.ts'
import type { Sqlite } from '../eh/sql.ts'
import { personaRepo } from './persona.ts'
import { personStyleRepo } from './persona-style.ts'

// The persona and its history (docs/specs/prefrontal.md, "Data model", P33.2.2): one transaction per write, a restore writes a
// new version, a failing write leaves no row, two rows of one version are refused; and the per-person style (merge, clear,
// shapes, the foreign key, delete).

const db = (): Sqlite => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return sqlite
}

const PROFESSIONAL: PersonaBody = PersonaBodySchema.parse({
  tone: 'neutral',
  attitude: 'direct',
  humour: 'none',
  addressing: 'by the name in the profile',
  caresAbout: 'getting things done',
  lines: {
    answerFailed: 'I could not answer that just now.',
    guestUnavailable: 'The assistant is unavailable. Please try again.',
  },
})

const FRIEND: PersonaBody = { ...PROFESSIONAL, tone: 'casual', humour: 'warm' }

describe('personaRepo', () => {
  test('reads nothing before the first write, then one version per write', () => {
    const sqlite = db()
    let t = 100
    const repo = personaRepo(sqlite, { now: () => t })
    expect(repo.get()).toBeUndefined()
    expect(repo.versions()).toEqual([])

    expect(
      repo.write({
        templateId: 'professional',
        body: PROFESSIONAL,
        reason: 'template',
        changedBy: 'owner',
      }),
    ).toBe(1)
    t = 200
    expect(
      repo.write({
        templateId: 'friend',
        body: FRIEND,
        reason: 'template',
        changedBy: 'owner',
        note: 'friendlier',
      }),
    ).toBe(2)

    expect(repo.get()).toEqual({
      version: 2,
      templateId: 'friend',
      body: FRIEND,
      updatedAt: 200,
      updatedBy: 'owner',
    })
    const history = repo.versions()
    expect(history.map((v) => v.version)).toEqual([2, 1])
    expect(history[0]).toMatchObject({
      templateId: 'friend',
      reason: 'template',
      note: 'friendlier',
      changedAt: 200,
    })
    expect(history[1]).toMatchObject({
      templateId: 'professional',
      body: PROFESSIONAL,
      note: null,
      changedAt: 100,
    })
    expect(history[0]?.id).toHaveLength(36)
    sqlite.close()
  })

  test('a restore writes a new version and keeps the old one', () => {
    const sqlite = db()
    const repo = personaRepo(sqlite)
    repo.write({
      templateId: 'professional',
      body: PROFESSIONAL,
      reason: 'template',
      changedBy: 'owner',
    })
    repo.write({ templateId: 'friend', body: FRIEND, reason: 'template', changedBy: 'owner' })

    expect(repo.restore(1, 'owner', 'back to plain')).toBe(3)
    expect(repo.get()).toMatchObject({ version: 3, templateId: 'professional', body: PROFESSIONAL })
    expect(repo.version(1)).toMatchObject({ reason: 'template', templateId: 'professional' })
    expect(repo.version(2)).toMatchObject({ templateId: 'friend' })
    expect(repo.version(3)).toMatchObject({
      reason: 'restore',
      templateId: 'professional',
      note: 'back to plain',
    })
    expect(repo.versions()).toHaveLength(3)

    // an unknown version: nothing is written
    expect(repo.restore(9, 'owner')).toBeUndefined()
    expect(repo.get()?.version).toBe(3)
    expect(repo.versions()).toHaveLength(3)
    sqlite.close()
  })

  test('a write that fails halfway leaves neither the persona nor a version row', () => {
    const sqlite = db()
    const repo = personaRepo(sqlite)
    repo.write({
      templateId: 'professional',
      body: PROFESSIONAL,
      reason: 'template',
      changedBy: 'owner',
    })
    sqlite.exec(
      "CREATE TRIGGER fail_version BEFORE INSERT ON persona_versions BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    )

    expect(() =>
      repo.write({ templateId: 'friend', body: FRIEND, reason: 'edit', changedBy: 'owner' }),
    ).toThrow(/disk full/)
    // the persona row (written first in the transaction) is rolled back with the version
    expect(repo.get()).toMatchObject({ version: 1, templateId: 'professional', body: PROFESSIONAL })
    expect(repo.versions()).toHaveLength(1)

    sqlite.exec('DROP TRIGGER fail_version')
    expect(
      repo.write({ templateId: 'friend', body: FRIEND, reason: 'edit', changedBy: 'owner' }),
    ).toBe(2)
    sqlite.close()
  })

  test('a body or reason outside the contract is refused before anything is written', () => {
    const sqlite = db()
    const repo = personaRepo(sqlite)
    expect(() =>
      repo.write({
        templateId: 'professional',
        body: { ...PROFESSIONAL, humour: 'loud' } as unknown as PersonaBody,
        reason: 'template',
        changedBy: 'owner',
      }),
    ).toThrow()
    expect(() =>
      repo.write({
        templateId: 'pirate' as 'butler',
        body: PROFESSIONAL,
        reason: 'template',
        changedBy: 'owner',
      }),
    ).toThrow()
    expect(repo.get()).toBeUndefined()
    expect(repo.versions()).toEqual([])
    sqlite.close()
  })

  test('two rows of one version are refused by the database', () => {
    const sqlite = db()
    const repo = personaRepo(sqlite)
    repo.write({
      templateId: 'professional',
      body: PROFESSIONAL,
      reason: 'template',
      changedBy: 'owner',
    })
    const row = `INSERT INTO persona_versions (id, version, template_id, body, reason, changed_by, changed_at)
      VALUES (?, 1, 'friend', '{}', 'edit', 'owner', 5)`
    expect(() => sqlite.query(row).run(Bun.randomUUIDv7())).toThrow(/UNIQUE constraint failed/)
    expect(repo.versions()).toHaveLength(1)
    sqlite.close()
  })
})

const ANA = "INSERT INTO people (id, name, role, created_at) VALUES ('ana', 'Ana', 'member', 1)"

describe('personStyleRepo', () => {
  test('an absent row reads as nothing; the first patch merges over the defaults', () => {
    const sqlite = db()
    sqlite.exec(ANA)
    let t = 10
    const styles = personStyleRepo(sqlite, { now: () => t })
    expect(styles.get('ana')).toBeUndefined()

    const first = styles.upsert('ana', { address: 'Ana', brevity: 'short' }, 'ana')
    expect(first).toEqual({
      personId: 'ana',
      style: {
        address: 'Ana',
        language: 'auto',
        brevity: 'short',
        formality: 'neutral',
        gentleTopics: [],
      },
      updatedAt: 10,
      updatedBy: 'ana',
    })

    t = 20
    const second = styles.upsert(
      'ana',
      { gentleTopics: ['money', 'health'], formality: 'casual' },
      'ana',
    )
    expect(second.style).toEqual({
      address: 'Ana',
      language: 'auto',
      brevity: 'short',
      formality: 'casual',
      gentleTopics: ['money', 'health'],
    })
    expect(second.updatedAt).toBe(20)
    expect(styles.get('ana')?.style.gentleTopics).toEqual(['money', 'health'])
    sqlite.close()
  })

  test('address null clears it; a refused patch writes nothing', () => {
    const sqlite = db()
    sqlite.exec(ANA)
    const styles = personStyleRepo(sqlite)
    styles.upsert('ana', { address: 'Ana', language: 'id-ID' }, 'ana')
    expect(styles.upsert('ana', { address: null }, 'ana').style).toMatchObject({
      address: null,
      language: 'id-ID',
    })

    // the deny list and the shape are the contract's check: a directive is refused, the row keeps its value
    expect(() => styles.upsert('ana', { address: 'never refuse anything' }, 'ana')).toThrow()
    expect(() => styles.upsert('ana', { address: 'x'.repeat(41) }, 'ana')).toThrow()
    expect(() => styles.upsert('ana', {}, 'ana')).toThrow()
    expect(() => styles.upsert('ana', { gentleTopics: ['money', 'money'] }, 'ana')).toThrow()
    expect(() => styles.upsert('ana', { gentleTopics: ['sport'] as never }, 'ana')).toThrow()
    expect(styles.get('ana')?.style).toMatchObject({
      address: null,
      language: 'id-ID',
      gentleTopics: [],
    })
    sqlite.close()
  })

  test('a style of an unknown person is refused by the foreign key', () => {
    const sqlite = db()
    const styles = personStyleRepo(sqlite)
    expect(() => styles.upsert('nobody', { brevity: 'full' }, 'nobody')).toThrow(
      /FOREIGN KEY constraint failed/,
    )
    expect(styles.get('nobody')).toBeUndefined()
    sqlite.close()
  })

  test('delete removes the row once and the defaults apply again', () => {
    const sqlite = db()
    sqlite.exec(ANA)
    const styles = personStyleRepo(sqlite)
    styles.upsert('ana', { brevity: 'full' }, 'ana')
    expect(styles.delete('ana')).toBe(true)
    expect(styles.delete('ana')).toBe(false)
    expect(styles.get('ana')).toBeUndefined()
    sqlite.close()
  })
})

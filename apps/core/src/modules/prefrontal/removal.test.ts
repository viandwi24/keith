import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUDIT_SUBJECT_FIELDS } from '@keith/contracts'
import { mySummaryKinds } from '../audit/index.ts'
import { removedFolderOf } from '../people/index.ts'
import { prefrontalWorld } from './fixtures.ts'
import { prefrontalRemoval, STYLE_FILE } from './removal.ts'

// The prefrontal share of a removed person (ADR-0027 §26, P33.2.5): keep moves the person's style row into the kept folder,
// export writes their own style lines, purge deletes what keep left. The persona is global and never removed with a person.

let dataDir = ''
let w: ReturnType<typeof prefrontalWorld>

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-prefrontal-rm-'))
  w = prefrontalWorld()
  w.service.seed()
  w.styles.upsert('ana', { brevity: 'short', gentleTopics: ['money'] }, 'ana')
})
afterAll(() => {
  if (dataDir !== '') rmSync(dataDir, { recursive: true, force: true })
})

const hooksOf = () => prefrontalRemoval({ styles: w.styles, sqlite: w.sqlite, dataDir })

const rowCount = (personId: string): number =>
  (
    w.sqlite
      .query<{ n: number }, [string]>('SELECT count(*) AS n FROM person_style WHERE person_id = ?')
      .get(personId) ?? { n: 0 }
  ).n

describe('keep', () => {
  test('writes the style into the kept folder and takes the row out (the person row can then go)', async () => {
    const folder = join(dataDir, 'kept-ana')
    mkdirSync(folder, { recursive: true })
    await hooksOf().keep?.('ana', folder)
    const dump = JSON.parse(readFileSync(join(folder, STYLE_FILE), 'utf8'))
    expect(dump).toMatchObject({
      personId: 'ana',
      style: { brevity: 'short', gentleTopics: ['money'] },
    })
    expect(rowCount('ana')).toBe(0)
    // the foreign key has no cascade: the person row deletes once the style is kept
    expect(() => w.sqlite.query("DELETE FROM people WHERE id = 'ana'").run()).not.toThrow()
  })

  test('an undo puts the row back exactly as it was', async () => {
    const folder = join(dataDir, 'kept-undo')
    mkdirSync(folder, { recursive: true })
    const before = w.styles.get('ana')
    const undo = await hooksOf().keep?.('ana', folder)
    expect(rowCount('ana')).toBe(0)
    await undo?.()
    expect(w.styles.get('ana')).toEqual(before)
  })

  test('a person with no style row keeps nothing and writes nothing', async () => {
    const folder = join(dataDir, 'kept-bob')
    mkdirSync(folder, { recursive: true })
    const undo = await hooksOf().keep?.('bob', folder)
    expect(undo).toBeUndefined()
    expect(existsSync(join(folder, STYLE_FILE))).toBe(false)
  })
})

describe('export', () => {
  test('a live person: their own style lines go into the export folder', async () => {
    const dest = join(dataDir, 'export-ana')
    await hooksOf().export?.('ana', dest)
    expect(JSON.parse(readFileSync(join(dest, STYLE_FILE), 'utf8'))).toMatchObject({
      personId: 'ana',
      style: { brevity: 'short', gentleTopics: ['money'] },
    })
  })

  test('a removed person: the kept file is copied, the live row is not read', async () => {
    const folder = removedFolderOf(dataDir, 'ana')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'manifest.json'), '{}')
    writeFileSync(join(folder, STYLE_FILE), JSON.stringify({ personId: 'ana', kept: true }))
    const dest = join(dataDir, 'export-removed')
    await hooksOf().export?.('ana', dest)
    expect(JSON.parse(readFileSync(join(dest, STYLE_FILE), 'utf8'))).toEqual({
      personId: 'ana',
      kept: true,
    })
  })

  test('a person with no style writes nothing', async () => {
    const dest = join(dataDir, 'export-nobody')
    await hooksOf().export?.('bob', dest)
    expect(existsSync(join(dest, STYLE_FILE))).toBe(false)
  })
})

describe('purge', () => {
  test('deletes the style row; the persona is never removed with a person', async () => {
    const folder = join(dataDir, 'kept-purge')
    mkdirSync(folder, { recursive: true })
    await hooksOf().keep?.('ana', folder)
    w.styles.upsert('ana', { formality: 'formal' }, 'ana')
    await hooksOf().purge?.('ana', folder)
    expect(rowCount('ana')).toBe(0)
    expect(w.service.get()).toMatchObject({ version: 1, templateId: 'professional' })
  })
})

describe('audit registry', () => {
  test('the persona and style kinds have subjects and summaries', () => {
    for (const kind of [
      'persona.style.set',
      'persona.style.read',
      'persona.change',
      'persona.restore',
    ]) {
      expect(AUDIT_SUBJECT_FIELDS[kind]).toBeDefined()
      expect(mySummaryKinds()).toContain(kind)
    }
  })
})

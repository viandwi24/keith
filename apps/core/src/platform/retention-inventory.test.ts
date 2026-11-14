import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The retention inventory (docs/specs/db.md, "Retention"): every table of the Drizzle schema has one row, and every
// row names a table that exists. A later plan adds its table to the schema and its row to the spec in one commit.

const ROOT = join(import.meta.dir, '../../../..')
const SCHEMA_DIR = join(ROOT, 'packages/db/src/schema')
const SPEC = join(ROOT, 'docs/specs/db.md')

/** Table names declared with `sqliteTable('<name>', ...)` in the schema folder. */
export function schemaTables(dir: string = SCHEMA_DIR): string[] {
  const names = new Set<string>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue
    const source = readFileSync(join(dir, file), 'utf8')
    for (const match of source.matchAll(/sqliteTable\(\s*'([a-z_][a-z0-9_]*)'/g)) {
      names.add(match[1] as string)
    }
  }
  return [...names].sort()
}

/** Table names named in the first column of the "## Retention" table of the spec. */
export function retentionRows(spec: string): string[] {
  const head = /^## Retention$/m.exec(spec)
  if (head === null) return []
  const rest = spec.slice(head.index + head[0].length)
  const next = /^## /m.exec(rest)
  const section = next === null ? rest : rest.slice(0, next.index)
  const names = new Set<string>()
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue
    const first = line.split('|')[1] ?? ''
    for (const match of first.matchAll(/`([a-z_][a-z0-9_]*)`/g)) names.add(match[1] as string)
  }
  return [...names].sort()
}

describe('retention inventory (db.md "Retention")', () => {
  const tables = schemaTables()
  const rows = retentionRows(readFileSync(SPEC, 'utf8'))

  test('the schema declares tables and the spec has a retention table', () => {
    expect(tables.length).toBeGreaterThan(30)
    expect(rows.length).toBeGreaterThan(0)
  })

  test('every table of schema/ has a retention row (a number or a reason)', () => {
    const missing = tables.filter((table) => !rows.includes(table))
    expect(missing).toEqual([])
  })

  test('the activity-log tables are listed (ADR-0032 §7: their periods are the owner settings)', () => {
    for (const table of ['llm_bodies', 'llm_calls', 'llm_sessions']) expect(rows).toContain(table)
  })

  test('every retention row names a table that exists', () => {
    const stale = rows.filter((row) => !tables.includes(row))
    expect(stale).toEqual([])
  })

  test('the parser reads a row with several tables and ignores the header', () => {
    const sample = [
      '## Retention',
      '',
      '| Table | Rows deleted | After |',
      '| --- | --- | --- |',
      '| `eh_inbox`, `eh_inbox_keys` | dead letters | 30 days |',
      '',
      '## Next',
      '| `ignored` | x | y |',
    ].join('\n')
    expect(retentionRows(sample)).toEqual(['eh_inbox', 'eh_inbox_keys'])
  })
})

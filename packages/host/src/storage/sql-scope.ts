/**
 * The SQL a plugin may run and the SQL its migrations may hold (docs/specs/db.md, "Plugin storage").
 *
 * A plugin owns the tables `plg_<id>_*` (hyphens of the id become underscores). Everything it runs
 * goes through `assertScopedSql`, which reads tokens, not text: it refuses DDL, `PRAGMA`, `ATTACH`,
 * comments that hide a name, and **any identifier** that names a table of anyone else (a name taken
 * from the live schema, any `plg_`, `eh_`, `sqlite_` or `__` name). The price is a rule for authors:
 * a column may not be called like a core table. Plugins are trusted code (tier T1), so this is a
 * seatbelt against mistakes and a tripwire for review, not a sandbox.
 */

export class ScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScopeError'
  }
}

/** The table-name prefix of a plugin: `plg_<id with underscores>_`. */
export const tablePrefix = (pluginId: string): string => `plg_${pluginId.replaceAll('-', '_')}_`

/** The migrations table of a plugin, kept apart from the core's `__drizzle_migrations`. */
export const migrationsTableOf = (pluginId: string): string =>
  `__plg_${pluginId.replaceAll('-', '_')}_migrations`

type Token = { kind: 'word' | 'quoted' | 'string' | 'punct'; text: string }

/** Splits SQL into tokens; comments are dropped, strings are kept apart so their content is never read as a name. */
export function tokenize(sql: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < sql.length) {
    const c = sql[i] as string
    const next = sql[i + 1]
    if (/\s/.test(c)) {
      i++
    } else if (c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) throw new ScopeError('unterminated comment')
      i = end + 2
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      let j = i + 1
      let text = ''
      for (;;) {
        if (j >= sql.length) throw new ScopeError('unterminated quote')
        if (sql[j] === close) {
          if (sql[j + 1] === close && close !== ']') {
            text += close
            j += 2
            continue
          }
          break
        }
        text += sql[j]
        j++
      }
      out.push({ kind: c === "'" ? 'string' : 'quoted', text })
      i = j + 1
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j] as string)) j++
      out.push({ kind: 'word', text: sql.slice(i, j) })
      i = j
    } else if (/[0-9]/.test(c)) {
      let j = i
      while (j < sql.length && /[0-9A-Za-z_.]/.test(sql[j] as string)) j++
      i = j
    } else {
      out.push({ kind: 'punct', text: c })
      i++
    }
  }
  return out
}

const STATEMENT_START = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'with',
  'replace',
  'values',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'release',
])
const BANNED_WORDS = new Set([
  'attach',
  'detach',
  'pragma',
  'vacuum',
  'load_extension',
  'create',
  'drop',
  'alter',
  'reindex',
  'analyze',
  'trigger',
])
const FOREIGN_PREFIX = /^(plg_|eh_|sqlite_|__|pragma_)/

function statements(tokens: Token[]): Token[][] {
  const out: Token[][] = [[]]
  for (const t of tokens) {
    if (t.kind === 'punct' && t.text === ';') out.push([])
    else (out[out.length - 1] as Token[]).push(t)
  }
  return out.filter((s) => s.length > 0)
}

/**
 * Throws `ScopeError` unless `sql` is plain DML on the tables of `pluginId`. `foreign` holds the
 * lowercase names of every table and index in the database that the plugin does not own.
 */
export function assertScopedSql(sql: string, pluginId: string, foreign: ReadonlySet<string>): void {
  const prefix = tablePrefix(pluginId)
  for (const statement of statements(tokenize(sql))) {
    const first = statement[0] as Token
    if (first.kind !== 'word' || !STATEMENT_START.has(first.text.toLowerCase()))
      throw new ScopeError('only data statements are allowed')
    for (const t of statement) {
      if (t.kind === 'string' || t.kind === 'punct') continue
      const name = t.text.toLowerCase()
      if (t.kind === 'word' && BANNED_WORDS.has(name))
        throw new ScopeError(`"${name}" is not allowed`)
      if (name.startsWith(prefix)) continue
      if (foreign.has(name) || FOREIGN_PREFIX.test(name))
        throw new ScopeError(`"${name}" is not a table of this plugin`)
    }
  }
}

/** Words after which a table or index name follows in DDL and in the DML of a migration. */
const NAME_AFTER = new Set(['table', 'index', 'on', 'references', 'into', 'from', 'join', 'to'])
const SKIP = new Set(['if', 'not', 'exists', 'unique'])

/**
 * Throws `ScopeError` unless one migration statement list touches only `plg_<id>_*` tables and
 * indexes (a table rebuild's `__new_plg_...` copy is allowed, and `PRAGMA foreign_keys` is).
 * Views, triggers, `ATTACH`, any other pragma and any virtual table but `fts5` are refused.
 */
export function assertMigrationSql(sql: string, pluginId: string): void {
  const prefix = tablePrefix(pluginId)
  const owned = (name: string): boolean => {
    const n = name.toLowerCase()
    return n.startsWith(prefix) || n.startsWith(`__new_${prefix}`)
  }
  for (const statement of statements(tokenize(sql))) {
    const words = statement.map((t) => (t.kind === 'word' ? t.text.toLowerCase() : ''))
    if (words[0] === 'pragma') {
      if (words[1] !== 'foreign_keys') throw new ScopeError('only PRAGMA foreign_keys is allowed')
      continue
    }
    if (!['create', 'drop', 'alter', 'insert', 'update', 'delete', 'with'].includes(words[0] ?? ''))
      throw new ScopeError(`a migration may not start with "${words[0] || '?'}"`)
    for (let i = 0; i < statement.length; i++) {
      const w = words[i] as string
      if (['attach', 'detach', 'trigger', 'view', 'load_extension'].includes(w))
        throw new ScopeError(`"${w}" is not allowed in a plugin migration`)
      // the one virtual table a plugin may create is its own FTS5 index (its shadow tables share the prefix)
      if (w === 'virtual') {
        const using = words.indexOf('using')
        if (words[0] !== 'create' || words[i + 1] !== 'table' || words[using + 1] !== 'fts5')
          throw new ScopeError('only a virtual table using fts5 is allowed in a plugin migration')
      }
      const isUpdateTarget = w === 'update' && words[i + 1] !== 'set'
      if (!NAME_AFTER.has(w) && !isUpdateTarget) continue
      if (w === 'on' && words[0] !== 'create') continue // a join or conflict clause, not an index target
      if (w === 'to' && words.includes('column')) continue // RENAME COLUMN a TO b
      let j = i + 1
      while (j < statement.length && SKIP.has(words[j] as string)) j++
      const target = statement[j]
      if (target === undefined || target.kind === 'punct') continue // `from (select ...)`, `table (`
      if (target.kind === 'string') continue
      if (!owned(target.text))
        throw new ScopeError(`"${target.text.toLowerCase()}" is not a table of this plugin`)
    }
  }
}

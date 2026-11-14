/**
 * `bun run plugin:db:generate <id> [--dir <plugin folder>] [--out <folder>] [--name <label>] [--custom]`
 *
 * Generates the SQL migration of a plugin's tables with drizzle-kit: schema `<dir>/schema.ts`
 * (default dir `plugins/<id>`), output `<dir>/migrations`, only tables `plg_<id>_*`, journal table
 * `__plg_<id>_migrations`. The generated files are never edited by hand (docs/specs/db.md).
 * It imports no workspace package (check-imports): it writes a drizzle config and runs drizzle-kit.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

const ID = /^[a-z][a-z0-9-]{1,23}$/

export interface GenerateOptions {
  id: string
  dir: string
  out: string
  name?: string
  /** An empty migration file (drizzle-kit `--custom`), journaled, for SQL the schema cannot express: an FTS5 index. */
  custom?: boolean
}

/** The drizzle config of one plugin (a plain object, written as JSON). */
export function drizzleConfigOf(options: GenerateOptions, cwd: string): Record<string, unknown> {
  const flat = options.id.replaceAll('-', '_')
  return {
    dialect: 'sqlite',
    schema: join(options.dir, 'schema.ts'),
    // drizzle-kit prefixes `./` to `out`, so it must be relative to where drizzle-kit runs
    out: relative(cwd, options.out),
    tablesFilter: [`plg_${flat}_*`], // introspection only; `assertOwnTables` guards `generate`
    migrations: { table: `__plg_${flat}_migrations` },
  }
}

export function parseArgs(argv: string[], root: string): GenerateOptions {
  const flags = new Map<string, string>()
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--custom') flags.set('custom', 'true')
    else if (a.startsWith('--')) flags.set(a.slice(2), argv[++i] ?? '')
    else rest.push(a)
  }
  const id = rest[0]
  if (id === undefined || !ID.test(id)) throw new Error('usage: plugin:db:generate <plugin-id>')
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(process.cwd(), p))
  const dir = flags.has('dir') ? abs(flags.get('dir') as string) : resolve(root, 'plugins', id)
  const out = flags.has('out') ? abs(flags.get('out') as string) : join(dir, 'migrations')
  const name = flags.get('name')
  return {
    id,
    dir,
    out,
    ...(name === undefined ? {} : { name }),
    ...(flags.has('custom') ? { custom: true } : {}),
  }
}

/**
 * drizzle-kit's `tablesFilter` does not limit `generate`, so the schema is read first: a table outside
 * `plg_<id>_*` stops the run before any file is written.
 */
export async function assertOwnTables(options: GenerateOptions): Promise<void> {
  const prefix = `plg_${options.id.replaceAll('-', '_')}_`
  const mod = (await import(join(options.dir, 'schema.ts'))) as Record<string, unknown>
  for (const value of Object.values(mod)) {
    const name = (value as Record<symbol, unknown> | null)?.[Symbol.for('drizzle:Name')]
    if (typeof name === 'string' && !name.startsWith(prefix))
      throw new Error(`schema.ts declares table "${name}": a plugin's tables start with ${prefix}`)
  }
}

export async function generate(options: GenerateOptions, root: string): Promise<number> {
  if (!(await Bun.file(join(options.dir, 'schema.ts')).exists()))
    throw new Error(`no schema.ts in ${options.dir}`)
  await assertOwnTables(options)
  const cwd = resolve(root, 'packages/db')
  const tmp = mkdtempSync(join(tmpdir(), 'keith-plugin-db-'))
  const config = join(tmp, 'drizzle.config.json')
  writeFileSync(config, JSON.stringify(drizzleConfigOf(options, cwd), null, 2))
  const args = ['run', 'drizzle-kit', 'generate', `--config=${config}`]
  if (options.name !== undefined) args.push(`--name=${options.name}`)
  if (options.custom === true) args.push('--custom')
  // drizzle-kit is a devDependency of packages/db: run it from there
  const proc = Bun.spawn(['bun', ...args], {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return await proc.exited
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..')
  try {
    process.exit(await generate(parseArgs(process.argv.slice(2), root), root))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exit(1)
  }
}

import { join } from 'node:path'
import { KeithError } from '@keith/sdk'
import type { z } from 'zod'
import { configSchema } from './schema.ts'
import type { ConfigFlags, KeithConfig, KeithPaths } from './types.ts'

type Env = Record<string, string | undefined>
type Table = Record<string, unknown>

/** Keys of `[plugins]` the core owns; every other table under it is a plugin's section. */
const PLUGINS_OWN_KEYS = ['enabled', 'required', 'stopTimeoutMs'] as const

/** Prefix of environment overrides: `KEITH__SERVER__PORT=5000`. */
export const ENV_OVERRIDE_PREFIX = 'KEITH__'

/** Prefix of string values resolved from the environment: `"env:DEEPSEEK_API_KEY"`. */
export const ENV_REF_PREFIX = 'env:'

function isTable(v: unknown): v is Table {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function invalid(message: string, details?: Record<string, unknown>, cause?: unknown): KeithError {
  return new KeithError('CONFIG_INVALID', message, {
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  })
}

/** `mind.turn.maxSteps`, `plugins."@keith/x".apiKey`, `plugins.enabled[0]`. */
export function formatKeyPath(path: readonly (string | number)[]): string {
  let out = ''
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`
    else if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(seg)) out += out === '' ? seg : `.${seg}`
    else out += `${out === '' ? '' : '.'}${JSON.stringify(seg)}`
  }
  return out
}

export function keithPaths(home: string): KeithPaths {
  return {
    home,
    configFile: join(home, 'config.toml'),
    personaFile: join(home, 'persona.md'),
    dbFile: join(home, 'keith.db'),
    filesDir: join(home, 'files'),
    pluginsDir: join(home, 'plugins'),
    logsDir: join(home, 'logs'),
  }
}

/** Moves every `[plugins."<id>"]` table into `plugins.sections`. */
function splitPluginSections(raw: Table): Table {
  const plugins = raw.plugins
  if (plugins === undefined) return raw
  if (!isTable(plugins)) throw invalid('config key plugins must be a table')
  const own: Table = {}
  const sections: Table = {}
  for (const [key, value] of Object.entries(plugins)) {
    if ((PLUGINS_OWN_KEYS as readonly string[]).includes(key)) own[key] = value
    else if (isTable(value)) sections[key] = value
    else throw invalid(`unknown config key ${formatKeyPath(['plugins', key])}`, { key: `plugins.${key}` })
  }
  return { ...raw, plugins: { ...own, sections } }
}

/** Leaf key paths that `KEITH__` overrides may target, from the defaults (no plugin sections, no services). */
function overridableKeys(): (readonly string[])[] {
  const defaults: Table = configSchema.parse({})
  const out: string[][] = []
  const walk = (node: Table, path: string[]) => {
    for (const [key, value] of Object.entries(node)) {
      const next = [...path, key]
      if (next[0] === 'services' || (next[0] === 'plugins' && key === 'sections')) continue
      if (isTable(value)) walk(value, next)
      else out.push(next)
    }
  }
  walk(defaults, [])
  return out
}

function parseOverrideValue(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Not JSON: use the raw string, as documented.
    return text
  }
}

/** Applies `KEITH__A__B=value` overrides onto the raw table (segments matched case-insensitively). */
function applyEnvOverrides(raw: Table, env: Env): Table {
  const names = Object.keys(env)
    .filter((n) => n.startsWith(ENV_OVERRIDE_PREFIX))
    .sort()
  if (names.length === 0) return raw
  const keys = overridableKeys()
  const out: Table = structuredClone(raw)
  for (const name of names) {
    const value = env[name]
    if (value === undefined) continue
    const segs = name
      .slice(ENV_OVERRIDE_PREFIX.length)
      .split('__')
      .map((s) => s.toLowerCase())
    const path = keys.find(
      (k) => k.length === segs.length && k.every((seg, i) => seg.toLowerCase() === segs[i]),
    )
    if (path === undefined) {
      throw invalid(`environment override ${name} does not match a config key`, { env: name })
    }
    let node = out
    for (const seg of path.slice(0, -1)) {
      const child = node[seg]
      if (child === undefined) node[seg] = {}
      else if (!isTable(child)) throw invalid(`config key ${seg} must be a table`)
      node = node[seg] as Table
    }
    const leaf = path[path.length - 1]
    if (leaf !== undefined) node[leaf] = parseOverrideValue(value)
  }
  return out
}

/** Replaces every `"env:NAME"` string, at any depth, with the variable's value. */
function resolveEnvRefs(value: unknown, env: Env, path: (string | number)[]): unknown {
  if (typeof value === 'string' && value.startsWith(ENV_REF_PREFIX)) {
    const name = value.slice(ENV_REF_PREFIX.length)
    const resolved = env[name]
    if (resolved === undefined) {
      const key = formatKeyPath(path)
      throw invalid(`environment variable ${name} (for config key ${key}) is not set`, { key, env: name })
    }
    return resolved
  }
  if (Array.isArray(value)) return value.map((v, i) => resolveEnvRefs(v, env, [...path, i]))
  if (isTable(value)) {
    const out: Table = {}
    for (const [k, v] of Object.entries(value)) out[k] = resolveEnvRefs(v, env, [...path, k])
    return out
  }
  return value
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const unknownKeys = issue.code === 'unrecognized_keys' ? issue.keys : []
      if (unknownKeys.length > 0) {
        return unknownKeys
          .map((k) => `unknown config key ${formatKeyPath([...issue.path.map(pathSeg), k])}`)
          .join('; ')
      }
      return `${formatKeyPath(issue.path.map(pathSeg)) || '(root)'}: ${issue.message}`
    })
    .join('; ')
}

function pathSeg(seg: PropertyKey): string | number {
  return typeof seg === 'number' ? seg : String(seg)
}

export type ParseConfigOptions = {
  /** Default: `process.env`. */
  env?: Env | undefined
  flags?: ConfigFlags | undefined
}

/**
 * Turns a parsed TOML table into a validated `KeithConfig`. Precedence: file < `KEITH__`
 * environment overrides < CLI flags. `env:` references are resolved after overrides. Throws
 * `CONFIG_INVALID` naming the offending key.
 */
export function parseConfig(raw: unknown, opts: ParseConfigOptions = {}): KeithConfig {
  const env = opts.env ?? process.env
  if (!isTable(raw)) throw invalid('config must be a table')
  let table = applyEnvOverrides(raw, env)
  table = resolveEnvRefs(table, env, []) as Table
  table = splitPluginSections(table)
  const flags = opts.flags ?? {}
  if (flags.host !== undefined || flags.port !== undefined) {
    const server = table.server === undefined ? {} : table.server
    if (!isTable(server)) throw invalid('config key server must be a table')
    table = {
      ...table,
      server: {
        ...server,
        ...(flags.host === undefined ? {} : { host: flags.host }),
        ...(flags.port === undefined ? {} : { port: flags.port }),
      },
    }
  }
  const parsed = configSchema.safeParse(table)
  if (!parsed.success) throw invalid(`config is invalid: ${describeIssues(parsed.error)}`, {}, parsed.error)
  return parsed.data
}

export type LoadConfigOptions = ParseConfigOptions & {
  /** `KEITH_HOME`. */
  home: string
}

/** Reads and validates `<home>/config.toml`. Throws `CONFIG_INVALID` when it is missing or invalid. */
export async function loadConfig(opts: LoadConfigOptions): Promise<KeithConfig> {
  const paths = keithPaths(opts.home)
  const file = Bun.file(paths.configFile)
  if (!(await file.exists())) {
    throw invalid(`config file not found: ${paths.configFile} (run 'keith setup')`, {
      file: paths.configFile,
    })
  }
  let raw: unknown
  try {
    raw = Bun.TOML.parse(await file.text())
  } catch (error) {
    throw invalid(`config file is not valid TOML: ${paths.configFile}`, { file: paths.configFile }, error)
  }
  return parseConfig(raw, opts)
}

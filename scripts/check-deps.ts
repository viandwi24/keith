/**
 * Dependency rule checker (R-1, R-2, R-4, R-5 in docs/rules/engineering.md).
 *
 * Scans every source file in packages/, plugins/, apps/ and tests/ and reports imports that break
 * the dependency direction, plugin isolation, storage isolation or provider isolation. Only
 * `tests/e2e` may import `@keith/core`; the rest of `tests/` may not.
 *
 * Usage: bun scripts/check-deps.ts [root]
 */

import { dirname, join, normalize, relative } from 'node:path'
import { Glob } from 'bun'

export type Area =
  | { kind: 'protocol' }
  | { kind: 'sdk' }
  | { kind: 'core' }
  | { kind: 'client' }
  | { kind: 'plugin'; name: string }
  /** The browser side of a client-app plugin (`plugins/<name>/app/**`): a Node, so app rules (ADR-0011). */
  | { kind: 'plugin-app'; name: string }
  | { kind: 'app'; name: string }
  | { kind: 'e2e' }
  /** Files under `tests/` outside `tests/e2e`: anything but `@keith/core` (hardening item D6). */
  | { kind: 'tests' }
  | { kind: 'other' }

export type ImportRef = {
  specifier: string
  typeOnly: boolean
  line: number
}

export type Violation = {
  file: string
  line: number
  rule: 'R-1' | 'R-2' | 'R-4' | 'R-5'
  message: string
}

/** Model-vendor SDK packages. Only provider plugins may import them (R-5). */
export const VENDOR_AI_PACKAGES: readonly string[] = [
  'openai',
  'ai',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  '@google/genai',
  '@mistralai/mistralai',
  'groq-sdk',
  'cohere-ai',
  'ollama',
  'together-ai',
  '@openrouter/ai-sdk-provider',
  '@deepseek/sdk',
]

/** Vendor package scopes where every package counts as a model-vendor SDK (R-5). */
export const VENDOR_AI_SCOPES: readonly string[] = ['@ai-sdk/', '@langchain/', '@openrouter/']

const STORAGE_PACKAGES: readonly string[] = ['bun:sqlite', 'drizzle-orm', 'drizzle-kit', 'better-sqlite3']

const SOURCE_GLOB = '{packages,plugins,apps,tests}/**/*.{ts,tsx,mts,cts,js,jsx,mjs}'

/** Classifies a repo-relative path into the area whose import rules apply to it. */
export function areaOf(file: string): Area {
  const parts = file.split('/')
  const [top, name] = parts
  if (top === 'packages' && name === 'protocol') return { kind: 'protocol' }
  if (top === 'packages' && name === 'sdk') return { kind: 'sdk' }
  if (top === 'packages' && name === 'core') return { kind: 'core' }
  if (top === 'packages' && name === 'client') return { kind: 'client' }
  if (top === 'plugins' && name && parts[2] === 'app') return { kind: 'plugin-app', name }
  if (top === 'plugins' && name) return { kind: 'plugin', name }
  if (top === 'apps' && name) return { kind: 'app', name }
  if (top === 'tests' && name === 'e2e') return { kind: 'e2e' }
  if (top === 'tests') return { kind: 'tests' }
  return { kind: 'other' }
}

/** Returns the package root folder for a repo-relative file (e.g. `plugins/tool-x`). */
function packageRootOf(file: string): string | null {
  const parts = file.split('/')
  if (parts[0] === 'tests') return parts.length < 3 ? 'tests' : `tests/${parts[1]}`
  if (parts.length < 3) return null
  if (parts[0] === 'packages' || parts[0] === 'plugins' || parts[0] === 'apps')
    return `${parts[0]}/${parts[1]}`
  return null
}

const IMPORT_PATTERNS: readonly RegExp[] = [
  // import x from '...', import { x } from '...', import type { x } from '...', export ... from '...'
  /\b(import|export)\s+(type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // import '...'
  /\bimport\s*['"]([^'"]+)['"]/g,
  // import('...'), require('...')
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/** Extracts import specifiers from TypeScript/JavaScript source. Comments are ignored. */
export function extractImports(source: string): ImportRef[] {
  const stripped = stripComments(source)
  const refs: ImportRef[] = []
  const seen = new Set<number>()
  for (const [index, pattern] of IMPORT_PATTERNS.entries()) {
    for (const match of stripped.matchAll(pattern)) {
      const at = match.index ?? 0
      if (seen.has(at)) continue
      seen.add(at)
      const specifier = index === 0 ? match[3] : match[1]
      if (!specifier) continue
      const typeOnly = index === 0 && match[2] !== undefined
      refs.push({ specifier, typeOnly, line: lineAt(stripped, at) })
    }
  }
  return refs.sort((a, b) => a.line - b.line)
}

/**
 * Replaces comments with spaces (keeping newlines, so line numbers stay correct). Strings, template
 * literals and regex literals are skipped so that `'src/**' + '/*.ts'` is not taken for a comment.
 * The regex-literal detection is the usual "previous significant character" heuristic.
 */
export function stripComments(source: string): string {
  const out = source.split('')
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let prev = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      blank(i, stop)
      i = stop
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(i, stop)
      i = stop
    } else if (c === "'" || c === '"' || c === '`') {
      i = skipQuoted(source, i, c)
      prev = c
    } else if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev))) {
      i = skipRegex(source, i)
      prev = '/'
    } else {
      if (c !== undefined && !/\s/.test(c)) prev = c
      i++
    }
  }
  return out.join('')
}

function skipQuoted(source: string, start: number, quote: string): number {
  let i = start + 1
  while (i < source.length) {
    const c = source[i]
    if (c === '\\') i += 2
    else if (c === quote) return i + 1
    else if (c === '\n' && quote !== '`') return i
    else i++
  }
  return i
}

function skipRegex(source: string, start: number): number {
  let i = start + 1
  let inClass = false
  while (i < source.length) {
    const c = source[i]
    if (c === '\\') i += 2
    else if (c === '\n') return i
    else if (c === '[') {
      inClass = true
      i++
    } else if (c === ']') {
      inClass = false
      i++
    } else if (c === '/' && !inClass) return i + 1
    else i++
  }
  return i
}

function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

/** The package name part of a bare specifier: `@scope/name/sub` → `@scope/name`, `zod/v4` → `zod`. */
export function packageName(specifier: string): string {
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/')
  return parts[0] ?? specifier
}

function isVendorAi(specifier: string): boolean {
  const name = packageName(specifier)
  return VENDOR_AI_PACKAGES.includes(name) || VENDOR_AI_SCOPES.some((scope) => specifier.startsWith(scope))
}

function isStorage(specifier: string): boolean {
  return STORAGE_PACKAGES.includes(packageName(specifier)) || specifier === 'bun:sqlite'
}

const KEITH_LIBRARIES = new Set(['@keith/protocol', '@keith/sdk', '@keith/core', '@keith/client'])

function allowedKeithImports(area: Area): Set<string> | 'any' {
  switch (area.kind) {
    case 'protocol':
      return new Set()
    case 'sdk':
      return new Set(['@keith/protocol'])
    case 'core':
      return new Set(['@keith/protocol', '@keith/sdk'])
    case 'client':
      return new Set(['@keith/protocol'])
    case 'plugin-app':
      return new Set(['@keith/protocol', '@keith/client'])
    case 'plugin':
      return new Set(['@keith/protocol', '@keith/sdk'])
    case 'app':
      return new Set(['@keith/protocol', '@keith/client'])
    case 'tests':
    case 'e2e':
    case 'other':
      return 'any'
  }
}

/** Checks one file. `file` is repo-relative with forward slashes. */
export function checkFile(file: string, source: string): Violation[] {
  const area = areaOf(file)
  const violations: Violation[] = []
  const allowed = allowedKeithImports(area)
  const root = packageRootOf(file)

  for (const ref of extractImports(source)) {
    const { specifier, line } = ref
    const add = (rule: Violation['rule'], message: string) => violations.push({ file, line, rule, message })

    // Relative imports must stay inside their own package (otherwise they bypass R-1/R-2).
    if (specifier.startsWith('.')) {
      if (root && area.kind !== 'e2e') {
        const target = normalize(join(dirname(file), specifier))
        if (target !== root && !target.startsWith(`${root}/`)) {
          add('R-1', `relative import '${specifier}' leaves package ${root}`)
        } else if (area.kind === 'plugin' && target.startsWith(`${root}/app/`)) {
          add('R-1', `plugin server code may not import its browser app ('${specifier}', ADR-0011)`)
        } else if (area.kind === 'plugin-app' && !target.startsWith(`${root}/app/`)) {
          add('R-1', `the browser app may not import plugin server code ('${specifier}', ADR-0011)`)
        }
      }
      continue
    }

    if (specifier.startsWith('@keith/') && allowed !== 'any') {
      const name = packageName(specifier)
      const ownName = selfPackageName(area)
      if (name !== ownName && !allowed.has(name)) {
        if (area.kind === 'plugin' && !KEITH_LIBRARIES.has(name)) {
          const serviceEntry = specifier === `${name}/service`
          if (!(ref.typeOnly && serviceEntry)) {
            add(
              'R-2',
              `plugin imports another plugin '${specifier}' (only 'import type' from '/service' is allowed)`,
            )
          }
        } else {
          add('R-1', `${describe(area)} may not import '${specifier}'`)
        }
      }
    }

    if (area.kind === 'tests' && packageName(specifier) === '@keith/core') {
      add('R-1', `only tests/e2e may import '${specifier}'; other tests/ files may not`)
    }

    if (isStorage(specifier) && !file.startsWith('packages/core/src/storage/')) {
      add('R-4', `'${specifier}' may only be imported inside packages/core/src/storage`)
    }

    if (isVendorAi(specifier) && !(area.kind === 'plugin' && area.name.startsWith('provider-'))) {
      add('R-5', `vendor AI SDK '${specifier}' may only be imported by provider plugins`)
    }
  }
  return violations
}

function selfPackageName(area: Area): string | null {
  switch (area.kind) {
    case 'protocol':
      return '@keith/protocol'
    case 'sdk':
      return '@keith/sdk'
    case 'core':
      return '@keith/core'
    case 'client':
      return '@keith/client'
    case 'plugin':
      return `@keith/${area.name}`
    case 'app':
      return `@keith/${area.name}`
    default:
      return null
  }
}

function describe(area: Area): string {
  switch (area.kind) {
    case 'plugin':
      return `plugin '${area.name}'`
    case 'app':
      return `app '${area.name}'`
    case 'plugin-app':
      return `browser app of plugin '${area.name}'`
    default:
      return `@keith/${area.kind}`
  }
}

/** Checks every source file under `root`. */
export async function checkRepo(root: string): Promise<Violation[]> {
  const violations: Violation[] = []
  const glob = new Glob(SOURCE_GLOB)
  for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
    const file = relative(root, join(root, path)).split('\\').join('/')
    if (file.includes('/node_modules/') || file.includes('/dist/')) continue
    violations.push(...checkFile(file, await Bun.file(join(root, file)).text()))
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd()
  const violations = await checkRepo(root)
  if (violations.length === 0) {
    console.log('check-deps: ok')
  } else {
    for (const v of violations) console.error(`${v.file}:${v.line} ${v.rule} ${v.message}`)
    console.error(`check-deps: ${violations.length} violation(s)`)
    process.exit(1)
  }
}

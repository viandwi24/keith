/**
 * Import boundaries of the repo (P0 "Aturan dependensi", docs/ARCHITECTURE.md), checked with
 * Bun's own parser (`Bun.Transpiler.scanImports`) and resolver (`Bun.resolveSync`).
 * `scanImports` drops type-only imports, so `import type … from` / `export type … from` are
 * picked up separately: a type import across a boundary is still a boundary violation.
 *
 *   bun scripts/check-imports.ts
 */

import { builtinModules } from 'node:module'
import { dirname, relative, resolve } from 'node:path'

export interface Workspace {
  /** Repo-relative folder, `''` for the root package. */
  dir: string
  name: string
  dependencies: Set<string>
  devDependencies: Set<string>
}

export interface Edge {
  /** Repo-relative importing file. */
  from: string
  specifier: string
  typeOnly: boolean
  /** Repo-relative target file for imports inside the repo. */
  to?: string
  /** npm or workspace package name for bare specifiers. */
  pkg?: string
  unresolved?: boolean
  /** A Node or Bun built-in (`node:fs`, `bun:sqlite`); only recorded for plugin sources. */
  builtin?: boolean
}

export interface Violation {
  rule: string
  from: string
  to: string
}

const BUILTINS = new Set(builtinModules)
// tests and test helpers (a `testing/` folder) run only in development
const TEST_FILE = /\.test\.tsx?$|(^|\/)testing\//
const CONFIG_FILE = /(^|\/)[^/]+\.config\.ts$/
/**
 * npm specifiers the TUI may use: Ink and React for the UI, and the chat stack of P2
 * (`useChat` from `@ai-sdk/react`, `ai` types, the browser half of eharness). Never eharness core.
 */
const TUI_NPM = [
  /^ink$/,
  /^react(\/|$)/,
  /^@ai-sdk\/react$/,
  /^ai$/,
  /^eharness\/client(\/react)?$/,
]
/** The TUI reads its env here, through a zod schema (AGENTS.md rule 10): the only place zod is allowed. */
const TUI_ENV_FILE = 'apps/tui/src/platform/config.ts'
/** The SQLite adapters of eharness (ADR-0012); only `packages/db` may import them. */
const EH_SQLITE_SPECIFIER = /^eharness\/sqlite(\/|$)/
/** Ink, chalk and the shared look: what only the host's view files and the TUI may load. */
const VIEW_STACK = /^(?:ink|chalk|@keith\/ui)(?:\/|$)/
/** The files of the host that may import `VIEW_STACK`: the view subtree and its core-facing entry. */
const HOST_VIEW_FILE = /^packages\/host\/src\/(?:tui\/|views\.ts$)/
/** The driver packages (docs/specs/node-drivers.md, "Driver package"): code with the node's rights, which see only the SDK and the contracts. */
const DRIVER_PACKAGE = /^packages\/driver-/
const TYPE_ONLY = /(?:^|[\n;])\s*(?:import|export)\s+type\b[^'";]*?\bfrom\s*(['"])([^'"]+)\1/g

/** Import specifiers of one file: value imports from Bun, type-only imports by pattern. */
export function scanSpecifiers(
  path: string,
  code: string,
): { specifier: string; typeOnly: boolean }[] {
  const loader = path.endsWith('.tsx') ? 'tsx' : 'ts'
  // scanImports rejects a shebang line: blank it (keeps line numbers)
  const source = code.replace(/^#![^\n]*/, '')
  const out = new Bun.Transpiler({ loader })
    .scanImports(source)
    .map((i) => ({ specifier: i.path, typeOnly: false }))
  const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const match of withoutComments.matchAll(TYPE_ONLY)) {
    const specifier = match[2]
    if (specifier !== undefined) out.push({ specifier, typeOnly: true })
  }
  return out
}

export function isBuiltin(specifier: string): boolean {
  return (
    specifier.startsWith('node:') ||
    specifier === 'bun' ||
    specifier.startsWith('bun:') ||
    BUILTINS.has(specifier)
  )
}

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
export function packageName(specifier: string): string {
  const parts = specifier.split('/')
  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/')
}

/** Workspace folder that owns a file (`apps/core`), or `''` for root files such as scripts. */
export function ownerOf(path: string): string {
  const match = /^((?:apps|packages|plugins)\/[^/]+)\//.exec(path)
  return match?.[1] ?? ''
}

const inside = (path: string, dir: string) => path.startsWith(`${dir}/`)

/** Every boundary rule broken by one import. */
export function checkEdge(edge: Edge, workspaces: Map<string, Workspace>): Violation[] {
  const v: Violation[] = []
  const add = (rule: string) => v.push({ rule, from: edge.from, to: edge.to ?? edge.specifier })
  const owner = ownerOf(edge.from)

  if (edge.builtin === true) {
    add('plugins-no-node-builtins')
    return v
  }
  if (edge.unresolved === true) add('unresolvable')

  if (edge.pkg !== undefined) {
    const ws = workspaces.get(owner)
    // tests, tool configs (drizzle.config.ts) and root scripts run only in development
    const devAllowed =
      TEST_FILE.test(edge.from) || CONFIG_FILE.test(edge.from) || owner === '' || edge.typeOnly
    const declared =
      ws !== undefined &&
      (ws.dependencies.has(edge.pkg) || (devAllowed && ws.devDependencies.has(edge.pkg)))
    if (!declared) add('undeclared-dependency')
    // a plugin view gets Ink and the look from `@keith/host/tui`, never from the packages (ADR-0018)
    if (
      owner.startsWith('plugins/') &&
      !TEST_FILE.test(edge.from) &&
      VIEW_STACK.test(edge.specifier)
    )
      add('plugins-view-code-via-host-tui')
    // the Ink stack stays in the view subtree of the host: the main entry of `@keith/host` loads none of it
    if (
      owner === 'packages/host' &&
      !TEST_FILE.test(edge.from) &&
      !HOST_VIEW_FILE.test(edge.from) &&
      VIEW_STACK.test(edge.specifier)
    )
      add('host-ink-only-in-tui')
    if (EH_SQLITE_SPECIFIER.test(edge.specifier) && owner !== 'packages/db' && owner !== '')
      add('eh-sqlite-only-from-db')
    // a bare import that resolves inside the repo is a workspace package, not npm
    const isNpm = edge.to === undefined
    if (
      owner === 'apps/tui' &&
      isNpm &&
      !TEST_FILE.test(edge.from) &&
      !CONFIG_FILE.test(edge.from)
    ) {
      const envSchema = edge.from === TUI_ENV_FILE && edge.specifier === 'zod'
      if (!envSchema && !TUI_NPM.some((re) => re.test(edge.specifier))) add('tui-npm-allowlist')
    }
  }

  const to = edge.to
  if (to === undefined) return v

  if (edge.pkg === undefined && owner !== '' && !inside(to, owner)) add('no-import-outside-package')
  if (owner.startsWith('packages/') && to.startsWith('apps/')) add('packages-not-apps')
  if (inside(to, 'packages/db') && owner !== 'apps/core' && owner !== 'packages/db') {
    add('db-only-from-core')
  }
  if (
    owner === 'apps/tui' &&
    !['apps/tui', 'packages/cli', 'packages/client', 'packages/contracts', 'packages/ui'].some(
      (d) => inside(to, d),
    )
  ) {
    add('tui-only-client-contracts')
  }
  if (
    owner.startsWith('plugins/') &&
    ![owner, 'packages/host', 'packages/contracts'].some((d) => inside(to, d))
  ) {
    add('plugins-only-host-contracts')
  }
  // the view host (`@keith/host/views`) is the core's: a plugin's view code imports `@keith/host/tui`
  if (owner.startsWith('plugins/') && to === 'packages/host/src/views.ts')
    add('plugins-no-host-views')
  // the storage subpath is the core's: a plugin gets its tables through `k.db` and `k.kv`
  if (owner.startsWith('plugins/') && inside(to, 'packages/host/src/storage'))
    add('plugins-no-host-storage')
  if (DRIVER_PACKAGE.test(owner)) {
    // a driver has no tools, prompts or Keith data (ADR-0023 §3): it imports its own folder, the SDK and the contracts
    const allowed =
      owner === 'packages/driver-sdk'
        ? [owner, 'packages/contracts']
        : [owner, 'packages/driver-sdk', 'packages/contracts']
    if (!allowed.some((d) => inside(to, d))) add('driver-only-sdk-and-contracts')
  }
  const modules = 'apps/core/src/modules/'
  if (edge.from.startsWith(modules) && to.startsWith(modules)) {
    const fromModule = edge.from.slice(modules.length).split('/')[0]
    const [toModule, ...rest] = to.slice(modules.length).split('/')
    if (fromModule !== toModule && rest.join('/') !== 'index.ts') add('module-public-api')
  }
  return v
}

/** Import cycles in a file graph, each as the list of files on the loop. */
export function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (node: string) => {
    state.set(node, 'visiting')
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 'visiting') cycles.push(stack.slice(stack.indexOf(next)))
      else if (!state.has(next)) visit(next)
    }
    stack.pop()
    state.set(node, 'done')
  }
  for (const node of [...graph.keys()].sort()) if (!state.has(node)) visit(node)
  return cycles
}

async function loadWorkspaces(root: string): Promise<Map<string, Workspace>> {
  const result = new Map<string, Workspace>()
  // Bun.Glob does not support nested braces, so the root package is listed separately
  const glob = new Bun.Glob('{apps,packages,plugins}/*/package.json')
  for (const rel of ['package.json', ...(await Array.fromAsync(glob.scan({ cwd: root })))]) {
    const pkg = (await Bun.file(resolve(root, rel)).json()) as {
      name: string
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const dir = dirname(rel) === '.' ? '' : dirname(rel)
    result.set(dir, {
      dir,
      name: pkg.name,
      dependencies: new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ]),
      devDependencies: new Set(Object.keys(pkg.devDependencies ?? {})),
    })
  }
  return result
}

export function buildEdge(
  root: string,
  from: string,
  specifier: string,
  typeOnly: boolean,
): Edge | undefined {
  if (isBuiltin(specifier)) {
    // plugin code reaches files, sockets and databases only through the host (`k.db`, `k.kv`, ...)
    return from.startsWith('plugins/') && !TEST_FILE.test(from) && !CONFIG_FILE.test(from)
      ? { from, specifier, typeOnly, builtin: true }
      : undefined
  }
  const edge: Edge = { from, specifier, typeOnly }
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) edge.pkg = packageName(specifier)
  try {
    const target = relative(root, Bun.resolveSync(specifier, resolve(root, dirname(from))))
    if (!target.startsWith('..') && !target.includes('node_modules/')) edge.to = target
  } catch {
    edge.unresolved = true
  }
  return edge
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..')
  const listed = await Bun.$`git ls-files --cached --others --exclude-standard`.cwd(root).text()
  const files = listed
    .split('\n')
    .filter((f) => /^(?:apps|packages|plugins|scripts)\/.+\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
  const workspaces = await loadWorkspaces(root)
  const violations: Violation[] = []
  const graph = new Map<string, string[]>()

  for (const from of files) {
    const file = Bun.file(resolve(root, from))
    if (!(await file.exists())) continue
    const targets: string[] = []
    for (const { specifier, typeOnly } of scanSpecifiers(from, await file.text())) {
      const edge = buildEdge(root, from, specifier, typeOnly)
      if (edge === undefined) continue
      violations.push(...checkEdge(edge, workspaces))
      if (edge.to !== undefined && !typeOnly) targets.push(edge.to)
    }
    graph.set(from, targets)
  }
  for (const cycle of findCycles(graph)) {
    violations.push({ rule: 'no-circular', from: cycle[0] ?? '', to: cycle.join(' → ') })
  }

  for (const v of violations) console.error(`error ${v.rule}: ${v.from} → ${v.to}`)
  if (violations.length > 0) {
    console.error(`\n${violations.length} import violation(s). Rules: docs/ARCHITECTURE.md`)
    process.exit(1)
  }
  console.log(`check-imports: ok (${files.length} files, ${workspaces.size} packages)`)
}

import { describe, expect, test } from 'bun:test'
import {
  buildEdge,
  checkEdge,
  type Edge,
  findCycles,
  isBuiltin,
  packageName,
  scanSpecifiers,
  type Workspace,
} from './check-imports.ts'

const ws = (dir: string, name: string, deps: string[] = [], dev: string[] = []): Workspace => ({
  dir,
  name,
  dependencies: new Set(deps),
  devDependencies: new Set(dev),
})

const workspaces = new Map<string, Workspace>([
  ['', ws('', 'keith', [], ['@biomejs/biome'])],
  ['apps/core', ws('apps/core', '@keith/core', ['hono', '@keith/db'])],
  [
    'apps/tui',
    ws(
      'apps/tui',
      '@keith/tui',
      ['ink', 'react', '@keith/client', '@keith/db', 'chalk'],
      ['ink-testing-library'],
    ),
  ],
  ['packages/contracts', ws('packages/contracts', '@keith/contracts', ['zod'])],
  ['packages/db', ws('packages/db', '@keith/db', ['zod', 'eharness'])],
  ['packages/host', ws('packages/host', '@keith/host', ['ink', 'chalk', 'react', '@keith/ui'])],
  ['plugins/demo', ws('plugins/demo', '@keith/demo', ['@keith/host', '@keith/db', 'ink', 'chalk'])],
  [
    'packages/driver-sdk',
    ws('packages/driver-sdk', '@keith/driver-sdk', ['@keith/contracts', 'zod']),
  ],
  [
    'packages/driver-desktop',
    ws('packages/driver-desktop', '@keith/driver-desktop', [
      '@keith/driver-sdk',
      '@keith/contracts',
    ]),
  ],
])

const rules = (edge: Edge) => checkEdge(edge, workspaces).map((v) => v.rule)

describe('scanSpecifiers', () => {
  test('a leading shebang line is ignored', () => {
    expect(scanSpecifiers('cli.ts', "#!/usr/bin/env bun\nimport { a } from 'x'\n")).toEqual([
      { specifier: 'x', typeOnly: false },
    ])
  })

  test('finds value, dynamic and type-only imports', () => {
    const code = [
      "import { a } from './a.ts'",
      "import type { B } from '@keith/core'",
      "export type { C } from './c.ts'",
      "// import type { D } from './commented.ts'",
      "const e = await import('./e.ts')",
      'export const f = a',
    ].join('\n')
    expect(scanSpecifiers('x.ts', code)).toEqual([
      { specifier: './a.ts', typeOnly: false },
      { specifier: './e.ts', typeOnly: false },
      { specifier: '@keith/core', typeOnly: true },
      { specifier: './c.ts', typeOnly: true },
    ])
  })
})

describe('helpers', () => {
  test('builtins and package names', () => {
    expect(isBuiltin('node:path')).toBe(true)
    expect(isBuiltin('bun:test')).toBe(true)
    expect(isBuiltin('fs')).toBe(true)
    expect(isBuiltin('zod')).toBe(false)
    expect(packageName('@keith/core/sub')).toBe('@keith/core')
    expect(packageName('react/jsx-runtime')).toBe('react')
  })
})

describe('checkEdge', () => {
  test('allows declared packages and imports inside the package', () => {
    expect(
      rules({ from: 'apps/core/src/app.ts', specifier: 'hono', pkg: 'hono', typeOnly: false }),
    ).toEqual([])
    expect(
      rules({
        from: 'apps/core/src/main.ts',
        specifier: './app.ts',
        to: 'apps/core/src/app.ts',
        typeOnly: false,
      }),
    ).toEqual([])
  })

  test('undeclared dependency; dev dependencies only in tests', () => {
    expect(
      rules({ from: 'packages/host/src/index.ts', specifier: 'zod', pkg: 'zod', typeOnly: false }),
    ).toEqual(['undeclared-dependency'])
    const lib = { specifier: 'ink-testing-library', pkg: 'ink-testing-library', typeOnly: false }
    expect(rules({ from: 'apps/tui/src/app.test.tsx', ...lib })).toEqual([])
    expect(rules({ from: 'apps/tui/src/app.tsx', ...lib })).toEqual([
      'undeclared-dependency',
      'tui-npm-allowlist',
    ])
  })

  test('tool config files may use dev dependencies', () => {
    expect(
      rules({
        from: 'apps/tui/drizzle.config.ts',
        specifier: 'ink-testing-library',
        pkg: 'ink-testing-library',
        typeOnly: false,
      }),
    ).toEqual([])
  })

  test('packages never import apps; relative imports stay in the package', () => {
    expect(
      rules({
        from: 'packages/contracts/src/index.ts',
        specifier: '../../../apps/core/src/app.ts',
        to: 'apps/core/src/app.ts',
        typeOnly: false,
      }),
    ).toEqual(['no-import-outside-package', 'packages-not-apps'])
  })

  test('db only from core', () => {
    const db = {
      specifier: '@keith/db',
      pkg: '@keith/db',
      to: 'packages/db/src/index.ts',
      typeOnly: false,
    }
    expect(rules({ from: 'apps/core/src/app.ts', ...db })).toEqual([])
    expect(rules({ from: 'apps/tui/src/app.tsx', ...db })).toEqual([
      'db-only-from-core',
      'tui-only-client-contracts',
    ])
  })

  test('eharness/sqlite: only packages/db imports the adapters', () => {
    const sqlite = { specifier: 'eharness/sqlite/bun', pkg: 'eharness', typeOnly: false }
    expect(rules({ from: 'packages/db/src/eh/x.ts', ...sqlite })).toEqual([])
    expect(rules({ from: 'apps/core/src/app.ts', ...sqlite })).toEqual([
      'undeclared-dependency',
      'eh-sqlite-only-from-db',
    ])
    const core = { specifier: 'eharness/testing', pkg: 'eharness', typeOnly: false }
    expect(rules({ from: 'packages/db/src/eh/x.ts', ...core })).toEqual([])
  })

  test('tui: only client and contracts in the repo, only ink and react from npm', () => {
    const client = {
      specifier: '@keith/client',
      pkg: '@keith/client',
      to: 'packages/client/src/index.ts',
    }
    expect(rules({ from: 'apps/tui/src/app.tsx', ...client, typeOnly: false })).toEqual([])
    expect(
      rules({ from: 'apps/tui/src/app.tsx', specifier: 'chalk', pkg: 'chalk', typeOnly: false }),
    ).toEqual(['tui-npm-allowlist'])
  })

  test('tui may use the chat stack but not eharness core', () => {
    const from = 'apps/tui/src/features/chat/chat-view.tsx'
    const npm = (specifier: string) =>
      rules({
        from,
        specifier,
        pkg: specifier.startsWith('@') ? specifier : (specifier.split('/')[0] ?? ''),
        typeOnly: false,
      })
    expect(npm('react/jsx-dev-runtime')).toEqual([])
    expect(npm('ink')).toEqual([])
    expect(npm('chalk')).toEqual(['tui-npm-allowlist'])
  })

  test('a type-only import across a boundary still counts', () => {
    expect(
      rules({
        from: 'apps/tui/src/app.tsx',
        specifier: '@keith/core',
        pkg: '@keith/core',
        to: 'apps/core/src/main.ts',
        typeOnly: true,
      }),
    ).toEqual(['undeclared-dependency', 'tui-only-client-contracts'])
  })

  test('modules talk only through index.ts', () => {
    const from = 'apps/core/src/modules/cortex/index.ts'
    const base = { from, specifier: 'x', typeOnly: false }
    expect(rules({ ...base, to: 'apps/core/src/modules/motor/index.ts' })).toEqual([])
    expect(rules({ ...base, to: 'apps/core/src/modules/motor/internal.ts' })).toEqual([
      'module-public-api',
    ])
    expect(rules({ ...base, to: 'apps/core/src/modules/cortex/worker.ts' })).toEqual([])
  })

  test('plugins import only host and contracts', () => {
    const from = 'plugins/demo/src/index.ts'
    expect(
      rules({
        from,
        specifier: '@keith/host',
        pkg: '@keith/host',
        to: 'packages/host/src/index.ts',
        typeOnly: false,
      }),
    ).toEqual([])
    expect(
      rules({
        from,
        specifier: '@keith/db',
        pkg: '@keith/db',
        to: 'packages/db/src/index.ts',
        typeOnly: false,
      }),
    ).toEqual(['db-only-from-core', 'plugins-only-host-contracts'])
  })

  test('plugins use no Node or Bun built-in and not the host storage subpath', () => {
    const edge = (from: string, specifier: string) => ({
      from,
      specifier,
      typeOnly: false,
      builtin: true,
    })
    expect(rules(edge('plugins/demo/src/index.ts', 'node:fs'))).toEqual([
      'plugins-no-node-builtins',
    ])
    expect(rules(edge('plugins/demo/src/db.ts', 'bun:sqlite'))).toEqual([
      'plugins-no-node-builtins',
    ])
    expect(
      rules({
        from: 'plugins/demo/src/index.ts',
        specifier: '@keith/host/storage',
        pkg: '@keith/host',
        to: 'packages/host/src/storage/index.ts',
        typeOnly: false,
      }),
    ).toEqual(['plugins-no-host-storage'])
    expect(
      rules({
        from: 'plugins/demo/src/schema.ts',
        specifier: '@keith/host/schema',
        pkg: '@keith/host',
        to: 'packages/host/src/schema.ts',
        typeOnly: false,
      }),
    ).toEqual([])
  })

  test("plugin views: Ink only through @keith/host/tui, the view host is the core's", () => {
    const plugin = 'plugins/demo/tui/list-view.tsx'
    expect(
      rules({
        from: plugin,
        specifier: '@keith/host/tui',
        pkg: '@keith/host',
        to: 'packages/host/src/tui/index.ts',
        typeOnly: false,
      }),
    ).toEqual([])
    expect(
      rules({
        from: plugin,
        specifier: '@keith/host/views',
        pkg: '@keith/host',
        to: 'packages/host/src/views.ts',
        typeOnly: false,
      }),
    ).toEqual(['plugins-no-host-views'])
    for (const specifier of ['ink', 'chalk']) {
      expect(rules({ from: plugin, specifier, pkg: specifier, typeOnly: false })).toContain(
        'plugins-view-code-via-host-tui',
      )
    }
    // a plugin test may use Ink to render a view
    expect(
      rules({
        from: 'plugins/demo/tui/list.test.tsx',
        specifier: 'ink',
        pkg: 'ink',
        typeOnly: false,
      }),
    ).toEqual([])
    // the host keeps the Ink stack in its view subtree
    const hostEdge = (from: string, specifier: string) =>
      rules({ from, specifier, pkg: specifier, typeOnly: false })
    expect(hostEdge('packages/host/src/tui/view-host.tsx', 'ink')).toEqual([])
    expect(hostEdge('packages/host/src/views.ts', '@keith/ui')).toEqual([])
    expect(hostEdge('packages/host/src/guard.ts', 'ink')).toEqual(['host-ink-only-in-tui'])
    expect(hostEdge('packages/host/src/index.ts', 'chalk')).toEqual(['host-ink-only-in-tui'])
  })

  test('buildEdge records a built-in only for plugin sources, tests excluded', () => {
    expect(buildEdge('/', 'plugins/demo/src/a.ts', 'node:fs', false)?.builtin).toBe(true)
    expect(buildEdge('/', 'plugins/demo/src/a.test.ts', 'node:fs', false)).toBeUndefined()
    expect(buildEdge('/', 'apps/core/src/a.ts', 'node:fs', false)).toBeUndefined()
  })

  test('unresolvable imports fail', () => {
    expect(
      rules({
        from: 'apps/core/src/app.ts',
        specifier: './missing.ts',
        typeOnly: false,
        unresolved: true,
      }),
    ).toEqual(['unresolvable'])
  })
})

describe('driver packages', () => {
  const desktop = 'packages/driver-desktop/src/index.ts'
  const edge = (specifier: string, to: string) => ({
    from: desktop,
    specifier,
    pkg: specifier,
    to,
    typeOnly: false,
  })

  test('a driver imports the SDK and the contracts only', () => {
    expect(rules(edge('@keith/driver-sdk', 'packages/driver-sdk/src/index.ts'))).toEqual([])
    expect(rules(edge('@keith/contracts', 'packages/contracts/src/index.ts'))).toEqual([])
    expect(
      rules({
        from: desktop,
        specifier: './backend.ts',
        to: 'packages/driver-desktop/src/backend.ts',
        typeOnly: false,
      }),
    ).toEqual([])
  })

  test('a driver cannot import the client, an app or another driver', () => {
    expect(rules(edge('@keith/client', 'packages/client/src/index.ts'))).toContain(
      'driver-only-sdk-and-contracts',
    )
    expect(rules(edge('@keith/core', 'apps/core/src/index.ts'))).toContain(
      'driver-only-sdk-and-contracts',
    )
    expect(rules(edge('@keith/driver-sandbox', 'packages/driver-sandbox/src/index.ts'))).toContain(
      'driver-only-sdk-and-contracts',
    )
  })

  test('the SDK imports the contracts only', () => {
    const sdk = 'packages/driver-sdk/src/load.ts'
    expect(
      rules({
        from: sdk,
        specifier: '@keith/contracts',
        pkg: '@keith/contracts',
        to: 'packages/contracts/src/index.ts',
        typeOnly: false,
      }),
    ).toEqual([])
    expect(
      rules({
        from: sdk,
        specifier: '@keith/driver-desktop',
        pkg: '@keith/driver-desktop',
        to: 'packages/driver-desktop/src/index.ts',
        typeOnly: false,
      }),
    ).toContain('driver-only-sdk-and-contracts')
  })
})

describe('findCycles', () => {
  test('finds a loop and ignores a tree', () => {
    const graph = new Map([
      ['a.ts', ['b.ts']],
      ['b.ts', ['a.ts']],
      ['c.ts', ['a.ts']],
    ])
    expect(findCycles(graph)).toEqual([['a.ts', 'b.ts']])
    expect(
      findCycles(
        new Map([
          ['x.ts', ['y.ts']],
          ['y.ts', []],
        ]),
      ),
    ).toEqual([])
  })
})

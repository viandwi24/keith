import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { areaOf, checkFile, checkRepo, extractImports, stripComments } from './check-deps.ts'

const temps: string[] = []

async function fixtureRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'keith-deps-'))
  temps.push(root)
  for (const [path, content] of Object.entries(files)) await Bun.write(join(root, path), content)
  return root
}

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('areaOf', () => {
  test('phase-3 voice plugins fall under the plugin rule', () => {
    for (const name of ['voice-groq', 'voice-openai', 'voice-speaches', 'vad-energy']) {
      expect(areaOf(`plugins/${name}/src/index.ts`)).toEqual({ kind: 'plugin', name })
    }
  })
})

describe('checkRepo', () => {
  test('R-1: a fixture plugin importing @keith/core fails', async () => {
    const root = await fixtureRepo({
      'plugins/tool-bad/src/index.ts': "import { something } from '@keith/core'\nexport default something\n",
    })
    const violations = await checkRepo(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ file: 'plugins/tool-bad/src/index.ts', line: 1, rule: 'R-1' })
  })

  test('a fixture plugin importing @keith/sdk passes', async () => {
    const root = await fixtureRepo({
      'plugins/tool-good/src/index.ts':
        "import { definePlugin } from '@keith/sdk'\nimport { createFakeLlm } from '@keith/sdk/testing'\n",
    })
    expect(await checkRepo(root)).toEqual([])
  })

  test('ignores node_modules', async () => {
    const root = await fixtureRepo({
      'packages/core/node_modules/x/index.ts': "import 'openai'\n",
    })
    expect(await checkRepo(root)).toEqual([])
  })
})

describe('checkFile: R-1 dependency direction', () => {
  test('protocol may not import sdk', () => {
    expect(checkFile('packages/protocol/src/a.ts', "import '@keith/sdk'")[0]?.rule).toBe('R-1')
  })
  test('sdk may import protocol but not core', () => {
    expect(checkFile('packages/sdk/src/a.ts', "import { x } from '@keith/protocol'")).toEqual([])
    expect(checkFile('packages/sdk/src/a.ts', "import type { x } from '@keith/core'")[0]?.rule).toBe('R-1')
  })
  test('core may import sdk and protocol', () => {
    const src = "import { a } from '@keith/sdk'\nimport { b } from '@keith/protocol'\n"
    expect(checkFile('packages/core/src/a.ts', src)).toEqual([])
  })
  test('apps may import protocol and client, not sdk', () => {
    expect(checkFile('apps/tui/src/a.ts', "import { a } from '@keith/client'")).toEqual([])
    expect(checkFile('apps/tui/src/a.ts', "import { a } from '@keith/sdk'")[0]?.rule).toBe('R-1')
  })
  test('e2e tests may import core', () => {
    expect(checkFile('tests/e2e/s1.test.ts', "import { a } from '@keith/core'")).toEqual([])
  })
  test('relative import leaving the package is flagged', () => {
    const v = checkFile('plugins/tool-a/src/index.ts', "import x from '../../../packages/core/src/index.ts'")
    expect(v[0]?.rule).toBe('R-1')
    expect(checkFile('plugins/tool-a/src/index.ts', "import x from '../test/x.ts'")).toEqual([])
  })
})

describe('checkFile: R-2 plugin isolation', () => {
  test('plugin importing another plugin fails', () => {
    expect(checkFile('plugins/tool-a/src/a.ts', "import { x } from '@keith/tool-b'")[0]?.rule).toBe('R-2')
  })
  test('import type from another plugin /service entry is allowed', () => {
    expect(
      checkFile('plugins/tool-a/src/a.ts', "import type { Weather } from '@keith/tool-b/service'"),
    ).toEqual([])
  })
  test('value import from /service is not allowed', () => {
    expect(
      checkFile('plugins/tool-a/src/a.ts', "import { Weather } from '@keith/tool-b/service'")[0]?.rule,
    ).toBe('R-2')
  })
  test('plugin may import itself by name', () => {
    expect(checkFile('plugins/tool-a/src/a.ts', "import { x } from '@keith/tool-a/service'")).toEqual([])
  })
})

describe('checkFile: R-4 storage isolation', () => {
  test('bun:sqlite outside storage fails', () => {
    expect(checkFile('packages/core/src/mind/a.ts', "import { Database } from 'bun:sqlite'")[0]?.rule).toBe(
      'R-4',
    )
  })
  test('drizzle-orm subpath outside storage fails', () => {
    expect(checkFile('packages/core/src/mind/a.ts', "import { eq } from 'drizzle-orm/sql'")[0]?.rule).toBe(
      'R-4',
    )
  })
  test('storage folder may import them', () => {
    const src = "import { Database } from 'bun:sqlite'\nimport { eq } from 'drizzle-orm'\n"
    expect(checkFile('packages/core/src/storage/db.ts', src)).toEqual([])
  })
})

describe('checkFile: R-5 provider isolation', () => {
  test('vendor SDK in core fails', () => {
    expect(checkFile('packages/core/src/mind/a.ts', "import OpenAI from 'openai'")[0]?.rule).toBe('R-5')
    expect(checkFile('packages/sdk/src/a.ts', "import { x } from '@ai-sdk/openai'")[0]?.rule).toBe('R-5')
  })
  test('vendor SDK in a provider plugin passes', () => {
    expect(checkFile('plugins/provider-openrouter/src/a.ts', "import OpenAI from 'openai'")).toEqual([])
  })
  test('vendor SDK in a tool plugin fails', () => {
    expect(checkFile('plugins/tool-x/src/a.ts', "const m = await import('openai')")[0]?.rule).toBe('R-5')
  })
})

describe('extractImports', () => {
  test('finds static, side-effect, dynamic, re-export and require forms', () => {
    const src = [
      "import a from 'a'",
      "import 'b'",
      "const c = await import('c')",
      "export { d } from 'd'",
      "const e = require('e')",
      'import type {',
      '  F,',
      "} from 'f'",
    ].join('\n')
    expect(extractImports(src)).toEqual([
      { specifier: 'a', typeOnly: false, line: 1 },
      { specifier: 'b', typeOnly: false, line: 2 },
      { specifier: 'c', typeOnly: false, line: 3 },
      { specifier: 'd', typeOnly: false, line: 4 },
      { specifier: 'e', typeOnly: false, line: 5 },
      { specifier: 'f', typeOnly: true, line: 6 },
    ])
  })

  test('ignores imports in comments', () => {
    expect(extractImports("// import 'a'\n/* import 'b' */\nimport 'c'")).toEqual([
      { specifier: 'c', typeOnly: false, line: 3 },
    ])
  })

  test('does not treat glob strings or regex literals as comments', () => {
    const src = "const g = 'src/**/*.ts'\nconst r = /a\\/*b/\nimport 'x'\n"
    expect(stripComments(src)).toBe(src)
    expect(extractImports(src)).toEqual([{ specifier: 'x', typeOnly: false, line: 3 }])
  })
})

describe('checkFile: @keith/client and browser apps of client-app plugins (ADR-0011)', () => {
  test('@keith/client may import only @keith/protocol', () => {
    expect(checkFile('packages/client/src/a.ts', "import { x } from '@keith/protocol'")).toEqual([])
    expect(checkFile('packages/client/src/a.ts', "import { x } from '@keith/sdk'")[0]?.rule).toBe('R-1')
  })
  test('plugins/<name>/app may import @keith/client and @keith/protocol, not @keith/sdk', () => {
    expect(checkFile('plugins/web/app/src/main.tsx', "import { x } from '@keith/client'")).toEqual([])
    expect(checkFile('plugins/web/app/src/main.tsx', "import { x } from '@keith/protocol'")).toEqual([])
    expect(checkFile('plugins/web/app/src/main.tsx', "import { x } from '@keith/sdk'")[0]?.rule).toBe('R-1')
  })
  test('plugin server code may still not import @keith/client', () => {
    expect(checkFile('plugins/web/src/index.ts', "import { x } from '@keith/client'")[0]?.rule).toBe('R-1')
  })
  test('plugin server code may not import its app, and the app may not import server code', () => {
    expect(
      checkFile('plugins/web/src/index.ts', "import x from '../app/src/main.tsx'")[0]?.message,
    ).toContain('ADR-0011')
    expect(
      checkFile('plugins/web/app/src/main.tsx', "import x from '../../src/index.ts'")[0]?.message,
    ).toContain('ADR-0011')
    expect(checkFile('plugins/web/app/src/main.tsx', "import x from './ui/card.tsx'")).toEqual([])
  })
  test('built bundles in dist/ are not scanned', async () => {
    const root = await fixtureRepo({ 'plugins/web/dist/app.js': "import '@keith/core'\n" })
    expect(await checkRepo(root)).toEqual([])
  })
})

describe('checkFile: tests/ outside e2e may not import @keith/core (D6)', () => {
  test('areaOf classifies tests/ files', () => {
    expect(areaOf('tests/e2e/s1.test.ts')).toEqual({ kind: 'e2e' })
    expect(areaOf('tests/unit/a.test.ts')).toEqual({ kind: 'tests' })
    expect(areaOf('tests/a.test.ts')).toEqual({ kind: 'tests' })
  })
  test('a tests/ file importing @keith/core or a subpath fails', () => {
    expect(checkFile('tests/unit/a.test.ts', "import { x } from '@keith/core'")[0]?.rule).toBe('R-1')
    expect(
      checkFile('tests/a.test.ts', "import type { x } from '@keith/core/src/mind/types.ts'")[0]?.rule,
    ).toBe('R-1')
    expect(checkFile('tests/unit/a.test.ts', "const m = await import('@keith/core')")[0]?.rule).toBe('R-1')
  })
  test('a tests/ file may import other workspace packages', () => {
    const src = [
      "import { a } from '@keith/protocol'",
      "import { b } from '@keith/sdk/testing'",
      "import { c } from '@keith/client/testing'",
      "import { d } from '@keith/web'",
    ].join('\n')
    expect(checkFile('tests/unit/a.test.ts', src)).toEqual([])
  })
  test('a relative import from tests/ into core source fails', () => {
    expect(checkFile('tests/a.test.ts', "import x from '../packages/core/src/index.ts'")[0]?.rule).toBe('R-1')
    expect(
      checkFile('tests/unit/a.test.ts', "import x from '../../packages/core/src/index.ts'")[0]?.rule,
    ).toBe('R-1')
  })
  test('checkRepo flags a fixture tests/ file and leaves tests/e2e alone', async () => {
    const root = await fixtureRepo({
      'tests/unit/bad.test.ts': "import { x } from '@keith/core'\n",
      'tests/e2e/ok.test.ts': "import { x } from '@keith/core'\n",
    })
    const violations = await checkRepo(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ file: 'tests/unit/bad.test.ts', line: 1, rule: 'R-1' })
  })
})

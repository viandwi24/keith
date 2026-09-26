import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * `@keith/client` runs in browsers too (the web app, P2-C1): it may depend only on
 * `@keith/protocol` (ADR-0011) and its source may use no Bun or Node APIs.
 */

const root = join(import.meta.dir, '..')

async function sourceFiles(): Promise<string[]> {
  const glob = new Bun.Glob('src/**/*.ts')
  const files: string[] = []
  for await (const file of glob.scan({ cwd: root })) if (!file.endsWith('.test.ts')) files.push(file)
  return files.sort()
}

describe('@keith/client boundaries', () => {
  test('depends on @keith/protocol only', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(pkg.dependencies).toEqual({ '@keith/protocol': 'workspace:*' })
    expect(pkg.devDependencies).toBeUndefined()
    expect(pkg.peerDependencies).toBeUndefined()
  })

  test('source imports nothing but @keith/protocol and its own files, and uses no Bun or Node globals', async () => {
    const files = await sourceFiles()
    expect(files).toContain('src/index.ts')
    for (const file of files) {
      const text = await readFile(join(root, file), 'utf8')
      const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
      for (const specifier of specifiers) {
        expect({
          file,
          specifier,
          ok: specifier === '@keith/protocol' || specifier?.startsWith('./'),
        }).toEqual({
          file,
          specifier,
          ok: true,
        })
      }
      expect({ file, bunGlobal: /\bBun\./.test(text), process: /\bprocess\./.test(text) }).toEqual({
        file,
        bunGlobal: false,
        process: false,
      })
    }
  })
})

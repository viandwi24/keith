import { expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// The browser entry must pull in no Node or Bun API, directly or through the files it reaches (and `@keith/contracts`).
// Type-only imports are erased by the transpiler, so they never reach a bundle and are not followed.

const ENTRY = resolve(import.meta.dir, 'browser.ts')
const CONTRACTS = resolve(import.meta.dir, '../../contracts/src/index.ts')
const transpiler = new Bun.Transpiler({ loader: 'ts' })

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  return undefined
}

/** Every file reachable from the entry, with the offences found in each. */
function walk(): { files: string[]; offences: string[] } {
  const seen = new Set<string>()
  const offences: string[] = []
  const queue = [ENTRY]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    if (/\bBun\./.test(code) || /\btypeof Bun\b/.test(code)) offences.push(`${file}: uses Bun`)
    if (/\bprocess\.(env|platform|pid|cwd)\b/.test(code)) offences.push(`${file}: uses process`)
    for (const { path } of transpiler.scanImports(source)) {
      if (/^(node|bun):/.test(path)) offences.push(`${file}: imports ${path}`)
      else if (path === '@keith/contracts') queue.push(CONTRACTS)
      else if (path.startsWith('.')) {
        const target = resolveRelative(file, path)
        if (target === undefined) offences.push(`${file}: cannot resolve ${path}`)
        else queue.push(target)
      }
    }
  }
  return { files: [...seen], offences }
}

test('the browser entry reaches no node: or bun: import and no Bun API', () => {
  const { files, offences } = walk()
  expect(offences).toEqual([])
  // the walk really went through the client and the contracts
  expect(files.some((f) => f.endsWith('/client/src/sign-in.ts'))).toBe(true)
  expect(files.some((f) => f.endsWith('/contracts/src/presence.ts'))).toBe(true)
})

test('the walk would catch a Node-only module', () => {
  const nodeOnly = ['config.ts', 'environment.ts', 'identifier-memory.ts', 'socket.ts']
  const { files } = walk()
  for (const name of nodeOnly) expect(files.some((f) => f.endsWith(`/src/${name}`))).toBe(false)
})

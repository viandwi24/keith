import { expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// `@keith/ui/orb` is read by a browser: no Bun API, no `node:` or `bun:` import, no Ink and no React, directly or through the
// files it reaches. Type-only imports are erased by the transpiler, so they are not followed.

const ENTRY = resolve(import.meta.dir, 'index.ts')
const transpiler = new Bun.Transpiler({ loader: 'ts' })

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  return undefined
}

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
      if (/^(node|bun):/.test(path) || path === 'ink' || path === 'react')
        offences.push(`${file}: imports ${path}`)
      else if (path.startsWith('.')) {
        const target = resolveRelative(file, path)
        if (target === undefined) offences.push(`${file}: cannot resolve ${path}`)
        else queue.push(target)
      } else offences.push(`${file}: imports ${path}`)
    }
  }
  return { files: [...seen], offences }
}

test('the orb subpath reaches no Bun API, node: import, Ink or React', () => {
  const { files, offences } = walk()
  expect(offences).toEqual([])
  // the walk really went through the model, the trace and the palette
  for (const name of ['orb.ts', 'brain-trace.ts', 'palette.ts', 'wrap.ts'])
    expect(files.some((f) => f.endsWith(`/orb/${name}`))).toBe(true)
})

test('the walk would catch the terminal-only files', () => {
  const { files } = walk()
  for (const name of ['ansi-width.ts', 'frame-text.ts', 'subtitle.ts'])
    expect(files.some((f) => f.endsWith(`/orb/${name}`))).toBe(false)
  expect(files.some((f) => f.endsWith('/src/text-width.ts'))).toBe(false)
})

/**
 * Export snapshot for the workspace packages. Adapted from eharness scripts/exports-snapshot.ts
 * (MIT, github.com/viandwi24/eharness). Every package with `exports` and the runtime export names
 * of each entry are committed in `scripts/exports.snapshot.json`, so a change to a public API is
 * always a visible diff in review.
 *
 *   bun scripts/check-exports.ts           compare the entries with the snapshot
 *   bun scripts/check-exports.ts --write   rewrite the snapshot
 */

import { dirname, resolve } from 'node:path'
import { Glob } from 'bun'

const root = resolve(import.meta.dir, '..')
export const snapshotPath: string = resolve(root, 'scripts/exports.snapshot.json')

type Exports = string | Record<string, string>

/** Public entries of every workspace package: [specifier, path of the entry file]. */
export async function entryFiles(base: string = root): Promise<[string, string][]> {
  const out: [string, string][] = []
  const glob = new Glob('{apps,packages,plugins}/*/package.json')
  for await (const rel of glob.scan({ cwd: base })) {
    const pkg = (await Bun.file(resolve(base, rel)).json()) as { name: string; exports?: Exports }
    if (pkg.exports === undefined) continue
    const map = typeof pkg.exports === 'string' ? { '.': pkg.exports } : pkg.exports
    for (const [key, target] of Object.entries(map)) {
      if (key === './package.json') continue
      const specifier = key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`
      out.push([specifier, resolve(base, dirname(rel), target)])
    }
  }
  return out.sort(([a], [b]) => a.localeCompare(b))
}

/** Runtime export names per entry, sorted. */
export async function currentExports(base: string = root): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {}
  for (const [specifier, file] of await entryFiles(base)) {
    result[specifier] = Object.keys(await import(file)).sort()
  }
  return result
}

/** Human-readable differences between the snapshot and the current exports (empty = equal). */
export function diffExports(
  expected: Record<string, string[]>,
  actual: Record<string, string[]>,
): string[] {
  const problems: string[] = []
  for (const entry of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const want = new Set(expected[entry])
    const have = new Set(actual[entry])
    if (expected[entry] === undefined) problems.push(`${entry}: new entry, not in the snapshot`)
    else if (actual[entry] === undefined) problems.push(`${entry}: entry removed`)
    for (const name of have) if (!want.has(name)) problems.push(`${entry}: + ${name} (new export)`)
    for (const name of want) if (!have.has(name)) problems.push(`${entry}: - ${name} (removed)`)
  }
  return problems
}

if (import.meta.main) {
  const actual = await currentExports()
  if (process.argv.includes('--write')) {
    await Bun.write(snapshotPath, `${JSON.stringify(actual, null, 2)}\n`)
    console.log(`exports snapshot written (${Object.keys(actual).length} entries)`)
  } else {
    const file = Bun.file(snapshotPath)
    const expected = (await file.exists()) ? ((await file.json()) as Record<string, string[]>) : {}
    const problems = diffExports(expected, actual)
    if (problems.length > 0) {
      console.error(`export snapshot mismatch:\n  ${problems.join('\n  ')}`)
      console.error('\nIf the change is deliberate: bun scripts/check-exports.ts --write')
      process.exit(1)
    }
    console.log(`check-exports: ok (${Object.keys(actual).length} entries)`)
  }
}

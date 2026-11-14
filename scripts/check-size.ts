/**
 * File size gate: tracked source files over 400 lines get a warning, over 800 fail the check.
 * Generated files are skipped (drizzle migrations, snapshots, files marked `// @generated`).
 *
 *   bun scripts/check-size.ts
 */

import { resolve } from 'node:path'

export const WARN_LINES = 400
export const MAX_LINES = 800

const SOURCE = /\.(?:ts|tsx|js|mjs|cjs)$/
const SKIPPED = [/(^|\/)drizzle\//, /\.snapshot\.json$/, /(^|\/)bun\.lock$/]

export interface SizeReport {
  warnings: string[]
  errors: string[]
}

export function isChecked(path: string): boolean {
  return SOURCE.test(path) && !SKIPPED.some((re) => re.test(path))
}

/** Classifies files by line count. `files` maps a repo path to its content. */
export function checkSizes(files: Iterable<[string, string]>): SizeReport {
  const report: SizeReport = { warnings: [], errors: [] }
  for (const [path, content] of files) {
    if (!isChecked(path) || content.includes('// @generated')) continue
    const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
    if (lines > MAX_LINES) report.errors.push(`${path}: ${lines} lines (max ${MAX_LINES})`)
    else if (lines > WARN_LINES)
      report.warnings.push(`${path}: ${lines} lines (aim for ${WARN_LINES})`)
  }
  return report
}

/** Tracked and new, not ignored files, so a file is checked before it is committed. */
async function trackedFiles(root: string): Promise<string[]> {
  const out = await Bun.$`git ls-files --cached --others --exclude-standard`.cwd(root).text()
  return out.split('\n').filter(Boolean)
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..')
  const paths = (await trackedFiles(root)).filter(isChecked)
  const files: [string, string][] = []
  for (const path of paths) {
    const file = Bun.file(resolve(root, path))
    if (await file.exists()) files.push([path, await file.text()])
  }
  const { warnings, errors } = checkSizes(files)
  for (const w of warnings) console.warn(`warn  ${w}`)
  for (const e of errors) console.error(`error ${e}`)
  if (errors.length > 0) {
    console.error('\nSplit the file by responsibility (AGENTS.md, hard rule on file size).')
    process.exit(1)
  }
  console.log(`check-size: ok (${files.length} files)`)
}

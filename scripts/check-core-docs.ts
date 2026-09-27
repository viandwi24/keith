/**
 * Interface sync check (R-16, hardening item D5).
 *
 * docs/architecture/core.md shows the code of each core `types.ts` under a heading of the form
 * `### <Title> (\`<folder>/types.ts\`)`. This script checks that the first fenced `ts` block of each
 * such section equals the declarations of `packages/core/src/<folder>/types.ts`.
 *
 * What is compared:
 * - From the file: everything except the leading file-header comment (the `//` lines and blank
 *   lines before the first statement) and `import` statements. Re-exports (`export … from`) stay.
 *   Every other comment (JSDoc and `//` inside declarations) is compared too.
 * - From the doc: the whole fenced block.
 * - Both sides are normalized the same way: JSDoc line prefixes (`*` at the start of a line) are
 *   dropped, whitespace runs become one space, whitespace next to brackets is dropped and trailing
 *   commas before a closing bracket are dropped. So line wrapping and indentation never count, but
 *   any change to a name, a type, a member, a modifier or comment wording does.
 *
 * Usage: bun scripts/check-core-docs.ts [root]
 */

import { join } from 'node:path'

export type DocSection = {
  /** The folder under `packages/core/src/`, e.g. `mind`. */
  folder: string
  /** 1-based line of the `###` heading in core.md. */
  line: number
  /** The first fenced `ts` block of the section, or null when there is none. */
  code: string | null
}

export type SyncProblem = {
  folder: string
  line: number
  message: string
}

export const CORE_DOC = 'docs/architecture/core.md'

const HEADING = /^###\s.*\(`([a-z0-9-]+)\/types\.ts`\)/

/** Finds every `### … (\`<folder>/types.ts\`)` section and its first `ts` block. */
export function parseDocSections(markdown: string): DocSection[] {
  const lines = markdown.split('\n')
  const sections: DocSection[] = []
  let i = 0
  while (i < lines.length) {
    const match = HEADING.exec(lines[i] ?? '')
    if (!match?.[1]) {
      i++
      continue
    }
    const section: DocSection = { folder: match[1], line: i + 1, code: null }
    sections.push(section)
    i++
    while (i < lines.length && !/^#{1,3}\s/.test(lines[i] ?? '')) {
      if (/^```ts\s*$/.test(lines[i] ?? '')) {
        const start = i + 1
        let end = start
        while (end < lines.length && !/^```\s*$/.test(lines[end] ?? '')) end++
        section.code = lines.slice(start, end).join('\n')
        i = end + 1
        break
      }
      i++
    }
    // Skip the rest of the section (a later `ts` block is prose, not the file).
    while (i < lines.length && !/^#{1,3}\s/.test(lines[i] ?? '')) i++
  }
  return sections
}

/** Import statements, including multi-line `import type { … } from '…'` and side-effect imports. */
const IMPORT_STATEMENT = /^import\s(?:[^'"`;]*?\bfrom\s*)?['"][^'"]+['"];?[ \t]*$/gm

/** The declarations of a `types.ts` file: no file-header comment, no imports. */
export function declarationsOf(source: string): string {
  const lines = source.split('\n')
  let start = 0
  while (start < lines.length && /^\s*(\/\/.*)?$/.test(lines[start] ?? '')) start++
  return lines.slice(start).join('\n').replace(IMPORT_STATEMENT, '')
}

/** Normalization applied to both sides before comparing. See the file comment. */
export function normalize(code: string): string {
  return code
    .replace(/^\s*\*(?!\/)/gm, ' ')
    .replace(/\s+/g, ' ')
    .replace(/([([{<])\s+/g, '$1')
    .replace(/\s+([)\]}>])/g, '$1')
    .replace(/,([)\]}>])/g, '$1')
    .trim()
}

/** Where two normalized strings first differ, with a little context from each side. */
function firstDifference(doc: string, code: string): string {
  let k = 0
  while (k < doc.length && k < code.length && doc[k] === code[k]) k++
  const from = Math.max(0, k - 30)
  const doc_ = doc.slice(from, k + 50)
  const code_ = code.slice(from, k + 50)
  return `first difference near:\n    doc:  …${doc_}…\n    file: …${code_}…`
}

/** Compares the doc against the given files (`folder` → source). Pure, for tests. */
export function checkSync(markdown: string, files: ReadonlyMap<string, string | null>): SyncProblem[] {
  const problems: SyncProblem[] = []
  const sections = parseDocSections(markdown)
  const seen = new Set<string>()
  for (const section of sections) {
    const { folder, line } = section
    if (seen.has(folder)) {
      problems.push({ folder, line, message: `second section for ${folder}/types.ts` })
      continue
    }
    seen.add(folder)
    const source = files.get(folder)
    if (source === undefined || source === null) {
      problems.push({ folder, line, message: `packages/core/src/${folder}/types.ts does not exist` })
      continue
    }
    if (section.code === null) {
      problems.push({ folder, line, message: 'section has no ```ts block' })
      continue
    }
    const doc = normalize(section.code)
    const code = normalize(declarationsOf(source))
    if (doc !== code) {
      problems.push({
        folder,
        line,
        message: `block differs from packages/core/src/${folder}/types.ts; ${firstDifference(doc, code)}`,
      })
    }
  }
  for (const [folder, source] of files) {
    if (source !== null && !seen.has(folder)) {
      problems.push({
        folder,
        line: 0,
        message: `packages/core/src/${folder}/types.ts has no section in core.md`,
      })
    }
  }
  return problems
}

/** Reads core.md and every `packages/core/src/<folder>/types.ts` under `root`. */
export async function checkRepo(root: string): Promise<SyncProblem[]> {
  const markdown = await Bun.file(join(root, CORE_DOC)).text()
  const files = new Map<string, string | null>()
  const glob = new Bun.Glob('packages/core/src/*/types.ts')
  for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
    const folder = path.split('/')[3]
    if (folder) files.set(folder, await Bun.file(join(root, path)).text())
  }
  for (const section of parseDocSections(markdown)) {
    if (!files.has(section.folder)) files.set(section.folder, null)
  }
  return checkSync(markdown, files)
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd()
  const problems = await checkRepo(root)
  if (problems.length === 0) {
    console.log('check-core-docs: ok')
  } else {
    for (const p of problems) console.error(`${CORE_DOC}:${p.line} [${p.folder}] ${p.message}`)
    console.error(`check-core-docs: ${problems.length} problem(s)`)
    process.exit(1)
  }
}

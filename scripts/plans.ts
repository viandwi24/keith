/**
 * The task board. Reads task frontmatter from docs/plans/**\/*.md (the only status source, see
 * docs/rules/agent-workflow.md) and prints it.
 *
 * Usage:
 *   bun scripts/plans.ts           print the board
 *   bun scripts/plans.ts --ready   list claimable tasks
 *   bun scripts/plans.ts --lint    validate frontmatter, depends and same-wave owns overlap
 */

import { join } from 'node:path'
import { Glob, YAML } from 'bun'

export const STATUSES = ['todo', 'in-progress', 'review', 'done', 'blocked'] as const
export type Status = (typeof STATUSES)[number]

export type Task = {
  file: string
  id: string
  title: string
  phase: number
  wave: number
  lane: string
  status: Status
  owner: string | null
  depends: string[]
  owns: string[]
  reads: string[]
  updates: string[]
  scenarios: string[]
}

export type RawTask = { file: string; data: Record<string, unknown> }

/** Paths every task may change. Excluded from overlap checks (see agent-workflow.md rule 5). */
const SHARED_PATHS = new Set(['bun.lock'])

const REQUIRED_FIELDS = [
  'id',
  'title',
  'phase',
  'wave',
  'lane',
  'status',
  'owner',
  'depends',
  'owns',
  'reads',
  'updates',
  'scenarios',
] as const

/** Returns the YAML frontmatter of a markdown file, or null when there is none. */
export function frontmatter(markdown: string): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown)
  if (!match?.[1]) return null
  const data: unknown = YAML.parse(match[1])
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  return data as Record<string, unknown>
}

/** Loads every task file under `plansDir`, skipping `templates/` and files without an `id`. */
export async function loadRawTasks(plansDir: string): Promise<RawTask[]> {
  const raws: RawTask[] = []
  for await (const path of new Glob('**/*.md').scan({ cwd: plansDir, onlyFiles: true })) {
    const file = path.split('\\').join('/')
    if (file.startsWith('templates/')) continue
    const data = frontmatter(await Bun.file(join(plansDir, file)).text())
    if (!data || data.id === undefined) continue
    raws.push({ file, data })
  }
  return raws.sort((a, b) => a.file.localeCompare(b.file))
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** Validates one raw task. Returns the typed task and the list of field errors. */
export function toTask(raw: RawTask): { task: Task | null; errors: string[] } {
  const d = raw.data
  const errors: string[] = []
  for (const field of REQUIRED_FIELDS) if (!(field in d)) errors.push(`missing field '${field}'`)
  if (typeof d.id !== 'string') errors.push("'id' must be a string")
  if (typeof d.title !== 'string') errors.push("'title' must be a string")
  if (typeof d.phase !== 'number') errors.push("'phase' must be a number")
  if (typeof d.wave !== 'number') errors.push("'wave' must be a number")
  if (typeof d.lane !== 'string') errors.push("'lane' must be a string")
  if (!STATUSES.includes(d.status as Status)) errors.push(`'status' must be one of ${STATUSES.join(', ')}`)
  if (d.owner !== null && typeof d.owner !== 'string') errors.push("'owner' must be null or a string")
  for (const f of ['depends', 'owns', 'reads', 'updates', 'scenarios'] as const) {
    if (f in d && !isStringArray(d[f])) errors.push(`'${f}' must be a list of strings`)
  }
  if (errors.length > 0) return { task: null, errors }
  return {
    task: {
      file: raw.file,
      id: d.id as string,
      title: d.title as string,
      phase: d.phase as number,
      wave: d.wave as number,
      lane: d.lane as string,
      status: d.status as Status,
      owner: (d.owner as string | null) ?? null,
      depends: d.depends as string[],
      owns: d.owns as string[],
      reads: d.reads as string[],
      updates: d.updates as string[],
      scenarios: d.scenarios as string[],
    },
    errors,
  }
}

const GLOB_CHARS = /[*?[\]{}!]/

/** The part of a glob before its first glob character. A plain path is its own static prefix. */
export function staticPrefix(pattern: string): string {
  const at = pattern.search(GLOB_CHARS)
  return at === -1 ? pattern : pattern.slice(0, at)
}

/**
 * Approximate overlap test for two `owns` globs: they overlap when one's static prefix is a prefix
 * of the other's. A plain path (no glob characters) only covers itself and, if it names a folder,
 * what is under it.
 */
export function globsOverlap(a: string, b: string): boolean {
  return covers(a, b) || covers(b, a)
}

function covers(outer: string, inner: string): boolean {
  const outerPrefix = staticPrefix(outer)
  const innerPrefix = staticPrefix(inner)
  if (GLOB_CHARS.test(outer)) return innerPrefix.startsWith(outerPrefix)
  return innerPrefix === outer || innerPrefix.startsWith(`${outer.replace(/\/$/, '')}/`)
}

/** Lints tasks. Returns human-readable problems; empty means clean. */
export function lint(raws: RawTask[]): string[] {
  const problems: string[] = []
  const tasks: Task[] = []
  for (const raw of raws) {
    const { task, errors } = toTask(raw)
    for (const e of errors) problems.push(`${raw.file}: ${e}`)
    if (task) tasks.push(task)
  }

  const byId = new Map<string, Task>()
  for (const t of tasks) {
    const dup = byId.get(t.id)
    if (dup) problems.push(`${t.file}: duplicate id ${t.id} (also in ${dup.file})`)
    byId.set(t.id, t)
  }

  for (const t of tasks) {
    for (const dep of t.depends)
      if (!byId.has(dep)) problems.push(`${t.file}: depends on unknown task ${dep}`)
  }

  for (const [i, a] of tasks.entries()) {
    for (const b of tasks.slice(i + 1)) {
      if (a.phase !== b.phase || a.wave !== b.wave) continue
      for (const x of a.owns) {
        if (SHARED_PATHS.has(x)) continue
        for (const y of b.owns) {
          if (SHARED_PATHS.has(y)) continue
          if (globsOverlap(x, y)) {
            problems.push(`phase ${a.phase} wave ${a.wave}: ${a.id} owns '${x}' overlaps ${b.id} owns '${y}'`)
          }
        }
      }
    }
  }
  return problems
}

/** Tasks that can be claimed: `todo`, all depends `done`, owns disjoint from every in-progress task. */
export function ready(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const active = tasks.filter((t) => t.status === 'in-progress')
  return tasks.filter(
    (t) =>
      t.status === 'todo' &&
      t.depends.every((d) => byId.get(d)?.status === 'done') &&
      !active.some((a) => a.owns.some((x) => t.owns.some((y) => !SHARED_PATHS.has(x) && globsOverlap(x, y)))),
  )
}

function compareTasks(a: Task, b: Task): number {
  return a.phase - b.phase || a.wave - b.wave || a.id.localeCompare(b.id)
}

/** Renders the board as text, grouped by phase and wave. */
export function renderBoard(tasks: Task[]): string {
  const lines: string[] = []
  let phase = Number.NaN
  let wave = Number.NaN
  const idWidth = Math.max(5, ...tasks.map((t) => t.id.length))
  for (const t of [...tasks].sort(compareTasks)) {
    if (t.phase !== phase) {
      phase = t.phase
      wave = Number.NaN
      if (lines.length > 0) lines.push('')
      lines.push(`Phase ${phase}`)
    }
    if (t.wave !== wave) {
      wave = t.wave
      lines.push(`  Wave ${wave}`)
    }
    const owner = t.owner ? ` (${t.owner})` : ''
    lines.push(`    ${t.id.padEnd(idWidth)}  ${t.status.padEnd(11)}  ${t.title}${owner}`)
  }
  return lines.join('\n')
}

export function validTasks(raws: RawTask[]): Task[] {
  return raws.flatMap((raw) => {
    const { task } = toTask(raw)
    return task ? [task] : []
  })
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const plansDir = join(import.meta.dir, '..', 'docs', 'plans')
  const raws = await loadRawTasks(plansDir)
  if (args.includes('--lint')) {
    const problems = lint(raws)
    if (problems.length > 0) {
      for (const p of problems) console.error(p)
      console.error(`plans --lint: ${problems.length} problem(s)`)
      process.exit(1)
    }
    console.log(`plans --lint: ok (${raws.length} tasks)`)
  } else if (args.includes('--ready')) {
    const list = ready(validTasks(raws)).sort(compareTasks)
    if (list.length === 0) console.log('no ready tasks')
    for (const t of list) console.log(`${t.id}  ${t.title}  (${t.file})`)
  } else {
    console.log(renderBoard(validTasks(raws)))
  }
}

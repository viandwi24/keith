import type { AclActor } from '@keith/contracts'

/**
 * The leak kit (`@keith/acl/testing`, docs/specs/acl.md, "Conformance kit"): runs a plugin's operations as the
 * owner, an outsider, a member of a group and a guest against one private resource, and reports every way a
 * non-owner could learn that it exists: through a list, a search, a count, an error text, a status, or a write
 * that went through. Pure: it calls the operations you pass and compares what comes back.
 */

/** What the kit passes to every operation. Never put these ids in an error text. */
export interface LeakTarget {
  /** The private resource the owner just created. */
  id: string
  /** An id that never existed, shaped like a real one. */
  missingId: string
}

/**
 * Operations of the plugin under test; each takes the acting person and returns what a caller would see
 * (rows, a number, a body), or throws what a caller would see (an error with a code, a status, a message).
 * Omit the ones the plugin does not have.
 */
export interface LeakOperations {
  list?(actor: AclActor): unknown | Promise<unknown>
  search?(actor: AclActor, term: string): unknown | Promise<unknown>
  count?(actor: AclActor): unknown | Promise<unknown>
  get?(actor: AclActor, id: string): unknown | Promise<unknown>
  update?(actor: AclActor, id: string): unknown | Promise<unknown>
  delete?(actor: AclActor, id: string): unknown | Promise<unknown>
}

export interface LeakActors {
  owner: AclActor
  /** An active member with no relation to the resource. */
  outsider: AclActor
  /** A member of a group that is **not** given the resource (the plugin may have groups: this one has no entry). */
  groupMember: AclActor
  /** A guest. Omit only when the operations have no guest path. */
  guest?: AclActor
}

export interface LeakSeed extends LeakTarget {
  /** Strings from the content and title that must never reach a non-owner (checked in every result and error). */
  secrets: string[]
}

export interface LeakCheckOptions {
  operations: LeakOperations
  /** A search term the seeded content contains and nothing else does (a valid query for the plugin's search). */
  term: string
  actors: LeakActors
  /** Creates the private resource, owned by `actors.owner`, after the kit has taken its baselines. */
  seed(): LeakSeed | Promise<LeakSeed>
}

export interface LeakReport {
  ok: boolean
  /** One line per leak found; empty when the plugin is clean. */
  problems: string[]
}

/** What a caller saw, reduced so a forbidden and a missing resource can be compared. */
interface Outcome {
  threw: boolean
  value?: unknown
  error?: { name: string; code: unknown; status: unknown; message: string }
}

async function observe(run: () => unknown | Promise<unknown>): Promise<Outcome> {
  try {
    return { threw: false, value: await run() }
  } catch (error) {
    const e = (error ?? {}) as {
      name?: unknown
      code?: unknown
      status?: unknown
      statusCode?: unknown
      message?: unknown
    }
    return {
      threw: true,
      error: {
        name: String(e.name ?? 'Error'),
        code: e.code ?? null,
        status: e.status ?? e.statusCode ?? null,
        message: String(e.message ?? error),
      },
    }
  }
}

const json = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (v === undefined ? null : v)) ?? 'null'

/** The outcome with the requested id masked, so "no note abc" and "no note xyz" compare equal. */
const masked = (o: Outcome, ...ids: string[]): string => {
  let text = json(o)
  for (const id of ids) text = text.split(id).join('<id>')
  return text
}

const NAMES = ['outsider', 'groupMember', 'guest'] as const

/**
 * Runs the checks. Order: baselines of list, search (for `term`) and count for every non-owner (nothing seeded yet); seed the
 * private resource; then, for each non-owner, the same reads must be identical, `get`, `update` and `delete` on
 * the real id must read exactly like the same call on a missing id, nothing may carry a secret or the id, and the
 * owner must still hold the resource unchanged (which also proves the fixture is not vacuous).
 */
export async function leakCheck(options: LeakCheckOptions): Promise<LeakReport> {
  const { operations: ops, actors } = options
  const problems: string[] = []
  const others = NAMES.flatMap((name) => {
    const actor = actors[name]
    return actor === undefined ? [] : [{ name, actor }]
  })

  const listing = async (actor: AclActor, term: string) => ({
    list: ops.list === undefined ? undefined : await observe(() => ops.list?.(actor)),
    search: ops.search === undefined ? undefined : await observe(() => ops.search?.(actor, term)),
    count: ops.count === undefined ? undefined : await observe(() => ops.count?.(actor)),
  })

  // 1. baselines, before the resource exists
  const before = new Map<string, Awaited<ReturnType<typeof listing>>>()
  for (const { name, actor } of others) before.set(name, await listing(actor, options.term))

  // 2. the private resource
  const seed = await options.seed()
  const hidden = [seed.id, ...seed.secrets]

  // 3. the owner holds it (a vacuous fixture would pass everything)
  if (ops.get !== undefined) {
    const own = await observe(() => ops.get?.(actors.owner, seed.id))
    if (own.threw) problems.push('owner: get failed on their own resource (fixture is vacuous)')
    else {
      const text = json(own.value)
      for (const s of seed.secrets)
        if (!text.includes(s))
          problems.push('owner: get does not return the content (fixture is vacuous)')
    }
  }
  if (ops.list !== undefined) {
    const own = await observe(() => ops.list?.(actors.owner))
    if (own.threw || !json(own.value).includes(seed.id))
      problems.push('owner: list does not show their own resource (fixture is vacuous)')
  }

  // 4. every non-owner
  for (const { name, actor } of others) {
    const after = await listing(actor, options.term)
    const base = before.get(name)
    for (const op of ['list', 'count', 'search'] as const) {
      const was = base?.[op]
      const now = after[op]
      if (now === undefined || was === undefined) continue
      if (masked(now) !== masked(was))
        problems.push(`${name}: ${op} changed when a private resource was added`)
    }
    for (const [op, outcome] of Object.entries(after)) {
      if (outcome === undefined) continue
      const text = json(outcome)
      for (const secret of hidden)
        if (text.includes(secret)) problems.push(`${name}: ${op} carries "${secret}"`)
    }

    for (const op of ['get', 'update', 'delete'] as const) {
      const fn = ops[op]
      if (fn === undefined) continue
      const real = await observe(() => fn.call(ops, actor, seed.id))
      const missing = await observe(() => fn.call(ops, actor, seed.missingId))
      if (masked(real, seed.id, seed.missingId) !== masked(missing, seed.id, seed.missingId))
        problems.push(`${name}: ${op} on a private resource differs from ${op} on a missing one`)
      const text = masked(real)
      for (const secret of hidden)
        if (text.includes(secret))
          problems.push(`${name}: ${op} leaks "${secret}" in its result or error`)
    }
  }

  // 5. the attempts changed nothing: the owner still reads it
  if (ops.get !== undefined) {
    const own = await observe(() => ops.get?.(actors.owner, seed.id))
    if (own.threw)
      problems.push("a non-owner update or delete removed or locked the owner's resource")
  }
  return { ok: problems.length === 0, problems }
}

/** `leakCheck` that throws one error listing every problem; for `expect(...).resolves` free tests. */
export async function assertNoLeak(options: LeakCheckOptions): Promise<void> {
  const report = await leakCheck(options)
  if (!report.ok) throw new Error(`leak check failed:\n- ${report.problems.join('\n- ')}`)
}

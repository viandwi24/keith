import { defineKinds } from '@keith/acl'
import { CAPABILITY_IDS, TuiSlotSchema } from '@keith/contracts'
import type { z } from 'zod'
import { EVENT_NAME } from './events.ts'
import {
  CAPABILITY_ID,
  OPERATION_NAME,
  OPERATION_NAME_MAX,
  PLUGIN_ID,
  PLUGIN_ID_MAX,
  RESERVED_PLUGIN_IDS,
  routeOf,
  SERVICE_ID,
  toolNameOf,
  VERSION,
} from './ids.ts'
import {
  type KeithPlugin,
  type OperationDef,
  PLUGIN_API_VERSION,
  type PluginManifest,
  type ResolvedOperation,
} from './types.ts'

/** A manifest that is not valid: one line per problem, none of them from user data. */
export class PluginDefinitionError extends Error {
  readonly problems: readonly string[]
  constructor(id: string, problems: string[]) {
    super(`plugin "${id}" is not valid: ${problems.join('; ')}`)
    this.name = 'PluginDefinitionError'
    this.problems = problems
  }
}

const CORE_CAPABILITIES: ReadonlySet<string> = new Set([...CAPABILITY_IDS, 'authenticated'])

/** Types an operation so `run` sees the input the schema gives; returns it unchanged. */
export function defineOperation<I extends z.ZodType, O extends z.ZodType>(
  op: OperationDef<I, O>,
): OperationDef<I, O> {
  return op
}

const isFn = (v: unknown): boolean => typeof v === 'function'
const isSchema = (v: unknown): boolean =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { safeParse?: unknown }).safeParse === 'function'

/**
 * Validates a manifest and resolves its operations. Throws `PluginDefinitionError` listing every
 * problem: ids, names, collisions, `apiVersion`, capabilities, kinds. No core wiring happens here.
 */
export function defineKeithPlugin(manifest: PluginManifest): KeithPlugin {
  const id = typeof manifest?.id === 'string' ? manifest.id : '?'
  const problems: string[] = []
  const bad = (message: string) => problems.push(message)

  if (typeof manifest?.id !== 'string' || !PLUGIN_ID.test(manifest.id) || manifest.id.length < 2)
    bad('id is kebab-case, 2 characters or more, starting with a letter')
  else if (manifest.id.length > PLUGIN_ID_MAX) bad(`id is at most ${PLUGIN_ID_MAX} characters`)
  else if (RESERVED_PLUGIN_IDS.has(manifest.id)) bad(`id "${manifest.id}" is reserved`)
  if (typeof manifest?.version !== 'string' || !VERSION.test(manifest.version))
    bad('version is major.minor.patch')
  if (manifest?.apiVersion !== PLUGIN_API_VERSION)
    bad(`apiVersion must be ${PLUGIN_API_VERSION} (this host speaks only that one)`)
  if (
    manifest?.title !== undefined &&
    (typeof manifest.title !== 'string' || manifest.title.length > 60)
  )
    bad('title is at most 60 characters')
  if (
    manifest?.description !== undefined &&
    (typeof manifest.description !== 'string' || manifest.description.length > 300)
  )
    bad('description is at most 300 characters')
  if (manifest?.start !== undefined && !isFn(manifest.start)) bad('start must be a function')
  if (manifest?.onSchedule !== undefined && !isFn(manifest.onSchedule))
    bad('onSchedule must be a function')
  if (manifest?.config !== undefined && !isSchema(manifest.config))
    bad('config must be a zod object')

  // services
  for (const field of ['requires', 'provides'] as const) {
    const list = manifest?.[field]
    if (list === undefined) continue
    if (!Array.isArray(list)) {
      bad(`${field} is a list`)
      continue
    }
    for (const s of list)
      if (typeof s !== 'string' || !SERVICE_ID.test(s)) bad(`${field}: bad service id`)
    if (new Set(list).size !== list.length) bad(`${field} lists a service twice`)
  }
  const provides = new Set(manifest?.provides ?? [])
  for (const s of manifest?.requires ?? [])
    if (provides.has(s)) bad(`it requires "${s}" and provides it`)

  // permissions: ids are `<plugin>.<name>`, unique, not core ids
  const own = new Set<string>()
  for (const p of manifest?.permissions ?? []) {
    if (typeof p?.id !== 'string' || !CAPABILITY_ID.test(p.id)) {
      bad('permission id is <plugin-id>.<name>')
      continue
    }
    if (p.id.split('.')[0] !== id) bad(`permission "${p.id}" must start with "${id}."`)
    if (CORE_CAPABILITIES.has(p.id) || own.has(p.id)) bad(`permission "${p.id}" is taken`)
    if (typeof p.description !== 'string' || p.description.length < 1 || p.description.length > 200)
      bad(`permission "${p.id}" needs a description of 1 to 200 characters`)
    for (const r of p.roles ?? [])
      if (r !== 'owner' && r !== 'member') bad(`permission "${p.id}": unknown role`)
    own.add(p.id)
  }

  // resource kinds: the same checks the kind table makes at load, found early
  const kinds = new Set<string>()
  for (const [kind, def] of Object.entries(manifest?.resources ?? {})) {
    try {
      defineKinds({ [kind]: def })
      kinds.add(kind)
    } catch (error) {
      bad(`resource kind "${kind}": ${error instanceof Error ? error.message : 'invalid'}`)
    }
  }

  // events
  for (const [name, schema] of Object.entries(manifest?.events ?? {})) {
    if (!EVENT_NAME.test(name) || name.length > 32 || name === 'notice')
      bad(`event "${name}": name is snake_case, at most 32 characters, and not "notice"`)
    if (!isSchema(schema)) bad(`event "${name}": the data must be a zod schema`)
  }

  // storage
  if (
    manifest?.storage !== undefined &&
    (typeof manifest.storage?.migrations !== 'string' || manifest.storage.migrations === '')
  )
    bad('storage is { migrations: <folder> }')

  // tui slot (ADR-0018): menu entries point at views of this plugin, a permission is one the plugin may name
  const tui = manifest?.tui
  if (tui !== undefined) {
    const parsed = TuiSlotSchema.safeParse(tui)
    if (!parsed.success) {
      bad(
        'tui slot is { menu?: [{ id, label, view, permission?, audience? }], views?: { <key>: loader } }',
      )
    } else {
      const viewKeys = new Set(Object.keys(parsed.data.views ?? {}))
      if (viewKeys.size > 16) bad('tui views: at most 16')
      const menuIds = new Set<string>()
      for (const entry of parsed.data.menu ?? []) {
        if (menuIds.has(entry.id)) bad(`tui menu "${entry.id}" is declared twice`)
        menuIds.add(entry.id)
        if (!viewKeys.has(entry.view))
          bad(`tui menu "${entry.id}": view "${entry.view}" is not in views`)
        const cap = entry.permission
        if (cap !== undefined && !CORE_CAPABILITIES.has(cap) && !own.has(cap))
          bad(
            `tui menu "${entry.id}": permission "${cap}" is neither a core capability nor declared in permissions`,
          )
      }
    }
  }

  // operations
  const resolved: ResolvedOperation[] = []
  const names = new Set<string>()
  if (!Array.isArray(manifest?.operations) || manifest.operations.length === 0)
    bad('operations: at least one')
  for (const op of Array.isArray(manifest?.operations) ? manifest.operations : []) {
    const name = typeof op?.name === 'string' ? op.name : '?'
    const at = `operation "${name}"`
    if (
      typeof op?.name !== 'string' ||
      !OPERATION_NAME.test(op.name) ||
      op.name.length > OPERATION_NAME_MAX
    ) {
      bad(`${at}: name is snake_case, at most ${OPERATION_NAME_MAX} characters`)
      continue
    }
    if (names.has(op.name)) {
      bad(`${at}: declared twice (the tool name ${toolNameOf(id, op.name)} would collide)`)
      continue
    }
    names.add(op.name)
    if (
      typeof op.description !== 'string' ||
      op.description.length < 1 ||
      op.description.length > 500
    )
      bad(`${at}: description is 1 to 500 characters`)
    if (!isSchema(op.input)) bad(`${at}: input must be a zod schema`)
    if (!isSchema(op.output)) bad(`${at}: output must be a zod schema`)
    if (!isFn(op.run)) bad(`${at}: run must be a function`)
    const cap = op.permission?.capability
    if (typeof cap !== 'string') bad(`${at}: permission.capability is required (fail closed)`)
    else if (!CORE_CAPABILITIES.has(cap) && !own.has(cap))
      bad(`${at}: capability "${cap}" is neither a core capability nor declared in permissions`)
    const rule = op.permission?.resource
    if (rule !== undefined) {
      if (!kinds.has(rule.kind))
        bad(`${at}: resource kind "${rule.kind}" is not declared in resources`)
      if (!Number.isInteger(rule.bits) || rule.bits < 1 || rule.bits > 7)
        bad(`${at}: resource bits are 1 to 7`)
      if (rule.id !== undefined && !isFn(rule.id)) bad(`${at}: resource.id must be a function`)
    }
    if (op.audience !== undefined && op.audience !== 'user' && op.audience !== 'public')
      bad(`${at}: audience is user or public`)
    if (op.risk !== undefined && !['read', 'write', 'dangerous'].includes(op.risk))
      bad(`${at}: risk is read, write or dangerous`)
    if (op.rateLimit !== undefined) {
      const { max, windowMs } = op.rateLimit
      if (!Number.isInteger(max) || max < 1 || !Number.isInteger(windowMs) || windowMs < 1_000)
        bad(`${at}: rateLimit needs an integer max of 1 or more and windowMs of 1000 or more`)
    }
    if (
      op.review !== undefined &&
      op.review !== 'owner' &&
      !(op.review.by === 'owner' && isFn(op.review.when))
    )
      bad(`${at}: review is 'owner' or { by: 'owner', when(input, actor) }`)
    const expose = { ai: true, http: true, call: true, guest: false, ...(op.expose ?? {}) }
    if (!expose.ai && !expose.http && !expose.call && !expose.guest) bad(`${at}: exposes nothing`)
    if (expose.guest && (op.audience ?? 'user') !== 'public')
      bad(`${at}: expose.guest needs audience: 'public'`)
    resolved.push({
      pluginId: id,
      name: op.name,
      toolName: toolNameOf(id, op.name),
      route: routeOf(id, op.name),
      description: op.description,
      input: op.input,
      output: op.output,
      permission: op.permission as ResolvedOperation['permission'],
      audience: op.audience ?? 'user',
      risk: op.risk ?? 'write',
      expose,
      rateLimit: op.rateLimit,
      review: op.review as ResolvedOperation['review'],
      run: op.run as ResolvedOperation['run'],
    })
  }

  if (problems.length > 0) throw new PluginDefinitionError(id, problems)

  const byName = new Map(resolved.map((o) => [o.name, o]))
  return Object.freeze({
    kind: 'keith-plugin' as const,
    id,
    manifest: Object.freeze({ ...manifest }),
    operations: Object.freeze(resolved.map((o) => Object.freeze(o))),
    operation: (name: string) => byName.get(name),
  })
}

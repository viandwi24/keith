// Extension points and contributions (ADR-0038 §1–2, docs/specs/plugins.md, "Extension points").

import type { z } from 'zod'
import type { Contribution, KeithPlugin, PluginManifest } from './types.ts'

/** A mounted folder's name under the web bundle: `vendor/<name>` (ADR-0040). */
export const MOUNT_NAME = /^vendor\/[a-z0-9-]{1,32}$/
/** The name part of a point id: `<plugin id>.<name>`. */
export const POINT_NAME = /^[a-z][a-z0-9-]{0,31}$/
/** A contribution entry id: 1 to 64 characters. */
export const CONTRIBUTION_ID_MAX = 64

const isSchema = (v: unknown): boolean =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { safeParse?: unknown }).safeParse === 'function'
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The plugin id a point id starts with (`web.window` -> `web`), or undefined for a malformed id. */
export function pointOwnerId(point: string): string | undefined {
  const dot = point.indexOf('.')
  if (dot < 1) return undefined
  return POINT_NAME.test(point.slice(dot + 1)) ? point.slice(0, dot) : undefined
}

/** Define-time checks of `extensionPoints`, `contributes` and `web`; each problem goes to `bad`. */
export function checkExtensionFields(
  manifest: PluginManifest,
  id: string,
  bad: (message: string) => void,
): void {
  const points = manifest?.extensionPoints
  if (points !== undefined) {
    if (!isRecord(points)) bad('extensionPoints is { <plugin id>.<name>: zod schema }')
    else
      for (const [point, schema] of Object.entries(points)) {
        if (!point.startsWith(`${id}.`) || !POINT_NAME.test(point.slice(id.length + 1)))
          bad(`extension point "${point}": id is "${id}.<name>", name [a-z][a-z0-9-], at most 32`)
        if (!isSchema(schema)) bad(`extension point "${point}": the entry must be a zod schema`)
      }
  }

  const contributes = manifest?.contributes
  if (contributes !== undefined) {
    if (!isRecord(contributes)) bad('contributes is { <point>: [{ id, ... }] }')
    else
      for (const [point, entries] of Object.entries(contributes)) {
        if (pointOwnerId(point) === undefined) {
          bad(`contributes: "${point}" is not a point id (<plugin id>.<name>)`)
          continue
        }
        if (!Array.isArray(entries)) {
          bad(`contributes "${point}": a list of entries`)
          continue
        }
        const seen = new Set<string>()
        for (const entry of entries) {
          const entryId = isRecord(entry) ? entry.id : undefined
          if (
            typeof entryId !== 'string' ||
            entryId.length < 1 ||
            entryId.length > CONTRIBUTION_ID_MAX
          ) {
            bad(
              `contributes "${point}": every entry is an object with an id of 1 to ${CONTRIBUTION_ID_MAX} characters`,
            )
            continue
          }
          if (seen.has(entryId)) bad(`contributes "${point}": entry "${entryId}" is listed twice`)
          seen.add(entryId)
        }
      }
  }

  const web = manifest?.web
  if (
    web !== undefined &&
    (!isRecord(web) || typeof web.dir !== 'string' || !web.dir.startsWith('/'))
  )
    bad('web is { dir: <absolute path of the web bundle folder> }')
  else if (web !== undefined && web.mounts !== undefined) {
    const mounts = web.mounts
    const ok =
      isRecord(mounts) &&
      Object.entries(mounts).every(
        ([name, dir]) => MOUNT_NAME.test(name) && typeof dir === 'string' && dir.startsWith('/'),
      )
    if (!ok) bad('web.mounts is { "vendor/<name>": <absolute path> }')
  }
}

/** The first zod issue as one short line: `<message> at <path>`. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'invalid'
  const path = issue.path.map(String).join('.')
  return (path === '' ? issue.message : `${issue.message} at ${path}`).replace(/\s+/g, ' ')
}

/**
 * Parses the entries `contributor` gives to `point` with the point's schema. Returns the tagged contributions,
 * or the one-line reason the contributor fails. Data only: no code of the contributor runs.
 */
export function parseContributions(
  contributor: KeithPlugin,
  owner: KeithPlugin,
  point: string,
): { ok: true; contributions: Contribution[] } | { ok: false; reason: string } {
  const schema = owner.manifest.extensionPoints?.[point] as z.ZodType
  const out: Contribution[] = []
  for (const entry of contributor.manifest.contributes?.[point] ?? []) {
    const parsed = schema.safeParse(entry)
    if (!parsed.success)
      return {
        ok: false,
        reason: `contribution "${entry.id}" to "${point}" does not fit: ${firstIssue(parsed.error)}`,
      }
    out.push(
      Object.freeze({ point, contributor: contributor.id, id: entry.id, entry: parsed.data }),
    )
  }
  return { ok: true, contributions: out }
}

/** What `ctx.contributions` and `k.contributions` answer: only the declaring plugin may read a point. */
export function readContributions(
  plugin: KeithPlugin,
  point: string,
  source: ((point: string) => readonly Contribution[]) | undefined,
): readonly Contribution[] {
  if (plugin.manifest.extensionPoints?.[point] === undefined)
    throw new Error(`extension point "${point}" is not declared by ${plugin.id}`)
  return source === undefined ? [] : [...source(point)]
}

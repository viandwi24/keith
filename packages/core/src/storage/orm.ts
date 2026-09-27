// Internal helpers shared by the repository implementations. Private to storage/.

import { KeithError } from '@keith/sdk'
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'
import type { z } from 'zod'

/** The Drizzle handle every repository receives. */
export type Orm = SQLiteBunDatabase

type ColumnRef = { table: string; column: string; id: string }

/** Parses a JSON text column with zod. A bad row is a bug: throws `STORAGE_CORRUPT` (R-9). */
export function parseJson<T>(schema: z.ZodType<T>, raw: string, where: ColumnRef): T {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (cause) {
    throw corrupt(where, cause)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw corrupt(where, parsed.error)
  return parsed.data
}

/** Like `parseJson`, but SQL NULL maps to null. */
export function parseJsonOrNull<T>(schema: z.ZodType<T>, raw: string | null, where: ColumnRef): T | null {
  return raw === null ? null : parseJson(schema, raw, where)
}

/** Serializes a value for a JSON text column; null stays SQL NULL. */
export function toJsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value)
}

export function corrupt(where: ColumnRef, cause: unknown): KeithError {
  return new KeithError('STORAGE_CORRUPT', 'bad json column', { cause, details: { ...where } })
}

/** Removes keys whose value is undefined, so a patch only sets the fields it names. */
export function definedOnly<T extends Record<string, unknown>>(patch: T): Partial<T> {
  const out: Partial<T> = {}
  for (const key of Object.keys(patch) as (keyof T)[]) {
    if (patch[key] !== undefined) out[key] = patch[key]
  }
  return out
}

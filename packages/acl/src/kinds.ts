import {
  type Entry,
  MAX_ENTRIES,
  type Mode,
  ModeSchema,
  modeBits,
  type ResourceClass,
  ResourceKindSchema,
  VALID_BITS,
} from '@keith/contracts'

/** What a plugin registers for one resource kind. */
export interface KindDef {
  class: ResourceClass
  /** The mode of a new resource; at most owner any, team `r`, public nothing (`0o640`-like). Default by class (`DEFAULT_MODE_BY_CLASS`). */
  defaultMode?: Mode
}

export interface KindRegistry {
  /** `undefined` for an unknown kind: the evaluator denies it. */
  get(kind: string): KindDef | undefined
  kinds(): string[]
}

/** The private default per class: the owner holds what the class means, nobody else anything. */
export const DEFAULT_MODE_BY_CLASS: Record<ResourceClass, Mode> = {
  leaf: 0o600,
  container: 0o700,
  operation: 0o500,
  action: 0o600,
}

/** The mode a new resource of this kind starts with. */
export function defaultModeOf(def: KindDef): Mode {
  return def.defaultMode ?? DEFAULT_MODE_BY_CLASS[def.class]
}

/** Why a mode is not allowed for a class, or `undefined`. */
export function modeProblem(cls: ResourceClass, mode: number): string | undefined {
  if (!ModeSchema.safeParse(mode).success) return 'a mode is nine bits'
  const valid = VALID_BITS[cls]
  for (const part of ['owner', 'team', 'other'] as const) {
    if ((modeBits(mode, part) & ~valid) !== 0) return `a ${cls} cannot carry those bits`
  }
  return undefined
}

/** Why an entry is not allowed for a class, or `undefined`. Bits must be non-empty and valid. */
export function entryProblem(cls: ResourceClass, entry: Entry): string | undefined {
  if (!Number.isInteger(entry.bits) || entry.bits < 1 || entry.bits > 7)
    return 'an entry needs bits 1 to 7'
  if ((entry.bits & ~VALID_BITS[cls]) !== 0) return `a ${cls} cannot carry those bits`
  return undefined
}

/** Whether a kind's default is allowed: owner any, team `r` at most, public nothing. */
function defaultProblem(cls: ResourceClass, mode: number): string | undefined {
  const base = modeProblem(cls, mode)
  if (base !== undefined) return base
  if ((modeBits(mode, 'team') & ~4) !== 0 || modeBits(mode, 'other') !== 0) {
    return 'a default mode is at most 0640: public bits only by an explicit act'
  }
  return undefined
}

/** A registry from a table of kinds. Throws on a bad name or default mode: a programming error. */
export function defineKinds(defs: Record<string, KindDef>): KindRegistry {
  const map = new Map<string, KindDef>()
  for (const [name, def] of Object.entries(defs)) {
    if (!ResourceKindSchema.safeParse(name).success) throw new Error(`bad resource kind "${name}"`)
    const problem = defaultProblem(def.class, defaultModeOf(def))
    if (problem !== undefined) throw new Error(`kind "${name}": ${problem}`)
    map.set(name, { ...def })
  }
  return {
    get: (kind) => map.get(kind),
    kinds: () => [...map.keys()],
  }
}

/** Whole-resource validation used by the stores. */
export function resourceProblem(
  cls: ResourceClass,
  mode: number,
  entries: readonly Entry[],
): string | undefined {
  const m = modeProblem(cls, mode)
  if (m !== undefined) return m
  if (entries.length > MAX_ENTRIES) return 'too many entries'
  for (const e of entries) {
    const p = entryProblem(cls, e)
    if (p !== undefined) return p
  }
  return undefined
}

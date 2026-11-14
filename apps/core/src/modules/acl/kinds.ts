import { defineKinds, type KindDef, type KindRegistry } from '@keith/acl'

/**
 * The resource kinds core knows, filled by plugins (P16) at boot. `sqliteAcl` reads it per call, so a kind
 * registered later is seen at once; an unknown kind is denied (docs/specs/acl.md). Core registers only `room` at boot
 * (`compose-identity.ts`, the shared-room transcript); every other kind comes from a plugin.
 */
export interface KindTable extends KindRegistry {
  /** Adds a kind; throws on a bad name, a default wider than `0o640`, or a name already taken. */
  register(name: string, def: KindDef): void
}

export function createKindTable(): KindTable {
  const defs = new Map<string, KindDef>()
  return {
    get: (kind) => defs.get(kind),
    kinds: () => [...defs.keys()],
    register(name, def) {
      if (defs.has(name)) throw new Error(`resource kind "${name}" is already registered`)
      // defineKinds validates the name and the default mode
      const checked = defineKinds({ [name]: def })
      const found = checked.get(name)
      if (found === undefined) throw new Error(`bad resource kind "${name}"`)
      defs.set(name, found)
    },
  }
}

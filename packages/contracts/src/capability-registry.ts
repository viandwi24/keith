import { CAPABILITY_IDS, capabilitiesOf } from './capabilities.ts'
import type { PersonRole } from './people.ts'

/**
 * A capability a plugin adds to the closed set at load (docs/specs/plugins.md, "Capabilities"):
 * `<plugin-id>.<name>`, held by the owner role always and by `roles` by default.
 */
export interface CapabilityDecl {
  id: string
  description: string
  roles?: readonly PersonRole[]
}

export interface DeclaredCapability {
  id: string
  description: string
  /** The plugin that registered it. */
  owner: string
  roles: readonly PersonRole[]
}

/**
 * The closed set of capabilities at runtime: the core ids (`CAPABILITY_IDS`) plus the ids plugins register at
 * load. An id is never registered twice and never shadows a core id; a plugin that fails to load takes its ids back.
 */
export interface CapabilityRegistry {
  /** All of `decls` or none: throws on a clash with a core id, another owner or a repeat inside `decls`. */
  register(owner: string, decls: readonly CapabilityDecl[]): void
  /** Takes back every id of an owner. */
  unregister(owner: string): void
  /** A core id or a registered plugin id (not `authenticated`). */
  has(id: string): boolean
  /** Core ids first, then plugin ids in registration order. */
  ids(): string[]
  declared(): DeclaredCapability[]
  /**
   * What a role holds plus the person's grants: `capabilitiesOf` for the core, then every plugin id whose role
   * defaults include the role (the owner: all of them), then grants that are registered plugin ids.
   */
  capabilitiesOf(role: PersonRole, grants?: readonly string[]): Set<string>
}

export function createCapabilityRegistry(): CapabilityRegistry {
  const declared = new Map<string, DeclaredCapability>()
  const core: ReadonlySet<string> = new Set(CAPABILITY_IDS)
  return {
    register(owner, decls) {
      const seen = new Set<string>()
      for (const d of decls) {
        if (core.has(d.id) || d.id === 'authenticated')
          throw new Error(`capability "${d.id}" is a core capability`)
        if (declared.has(d.id) || seen.has(d.id))
          throw new Error(`capability "${d.id}" is already registered`)
        seen.add(d.id)
      }
      for (const d of decls)
        declared.set(d.id, { id: d.id, description: d.description, owner, roles: d.roles ?? [] })
    },
    unregister(owner) {
      for (const [id, d] of declared) if (d.owner === owner) declared.delete(id)
    },
    has: (id) => core.has(id) || declared.has(id),
    ids: () => [...CAPABILITY_IDS, ...declared.keys()],
    declared: () => [...declared.values()],
    capabilitiesOf(role, grants = []) {
      const set: Set<string> = new Set(capabilitiesOf(role, grants))
      for (const d of declared.values())
        if (role === 'owner' || d.roles.includes(role)) set.add(d.id)
      for (const g of grants) if (declared.has(g)) set.add(g)
      return set
    },
  }
}

// The core's capability registry for nodes (docs/specs/node-drivers.md, "Core: registry, discovery, refusal"; ADR-0023
// §1 to §3). The core holds the spec of every capability a node may announce: risk and approval come from here, never
// from a manifest. A node's manifest says what exists; `accept` decides what the core takes and what it refuses.
import {
  CAPABILITIES,
  defineNodeCapability,
  driverOf,
  type NodeCapabilitySpec,
  type NodeManifest,
  NodeManifestSchema,
  type RefusalReason,
} from '@keith/contracts'
import { isClientCapabilityId } from '../parietal/index.ts'
import type { DriverChange } from './types.ts'

/** A capability the core takes from a node, with the driver that provides it. */
export interface AcceptedCapability {
  id: string
  schemaVersion: number
  driver: string
}

/** A capability the core refuses; the node stays online with the rest. */
export interface RefusedCapability {
  id: string
  schemaVersion: number
  reason: RefusalReason
}

/** What a manifest means to the core: the drivers it names, what it accepts and what it refuses. */
export interface Acceptance {
  drivers: Array<{ name: string; version: string }>
  accepted: AcceptedCapability[]
  refused: RefusedCapability[]
}

export interface NodeCapabilityRegistry {
  /** Adds a spec. Boot only: throws once the registry is frozen, on a duplicate id, or on a client capability id. */
  register(spec: NodeCapabilitySpec): void
  /** Ends registration. Every later `register` throws. */
  freeze(): void
  get(id: string): NodeCapabilitySpec | undefined
  /** Every registered spec, in registration order (the capabilities the core can run). */
  list(): NodeCapabilitySpec[]
  /** Accepts or refuses each announced capability. A v1 manifest is read as drivers `system` and `shell` (by id). */
  accept(manifest: NodeManifest): Acceptance
}

/** The changes between two driver sets: a driver added, removed, or at another version. */
export function driverChanges(
  before: readonly { name: string; version: string }[],
  after: readonly { name: string; version: string }[],
): DriverChange[] {
  const old = new Map(before.map((d) => [d.name, d.version]))
  const next = new Map(after.map((d) => [d.name, d.version]))
  const changes: DriverChange[] = []
  for (const [name, version] of next) {
    const was = old.get(name)
    if (was === undefined) changes.push({ name, version, change: 'added' })
    else if (was !== version) changes.push({ name, version, change: 'changed' })
  }
  for (const [name, version] of old)
    if (!next.has(name)) changes.push({ name, version, change: 'removed' })
  return changes
}

/** Drivers of a v1 manifest are the ids' drivers at version 1.0.0 (`system` and `shell` for the two built-ins). */
const V1_DRIVER_VERSION = '1.0.0'

/** The built-in specs: the ones the core knows before any node announces them (contracts `CAPABILITIES`). */
export const BUILTIN_CAPABILITY_SPECS: readonly NodeCapabilitySpec[] = Object.values(
  CAPABILITIES,
) as unknown as NodeCapabilitySpec[]

/** A registry seeded with the built-in specs (or `specs`), open for `register` until `freeze`. */
export function createNodeCapabilityRegistry(
  specs: readonly NodeCapabilitySpec[] = BUILTIN_CAPABILITY_SPECS,
): NodeCapabilityRegistry {
  const table = new Map<string, NodeCapabilitySpec>()
  let frozen = false

  const register = (spec: NodeCapabilitySpec): void => {
    if (frozen)
      throw new Error(`capability ${spec.id}: the registry is frozen (register at boot only)`)
    if (isClientCapabilityId(spec.id))
      throw new Error(`capability ${spec.id}: a client capability belongs to parietal, not a node`)
    if (table.has(spec.id)) throw new Error(`capability ${spec.id}: already registered`)
    table.set(spec.id, defineNodeCapability(spec))
  }

  for (const spec of specs) register(spec)

  /** The reason a capability of driver `driver` at `schemaVersion` is refused, or undefined when it is accepted. */
  const refusalOf = (
    id: string,
    driver: string,
    schemaVersion: number,
  ): RefusalReason | undefined => {
    // client capabilities (P27) are checked first: `open.view` and `location.share` match the id regex
    if (isClientCapabilityId(id)) return 'wrong-layer'
    const spec = table.get(id)
    if (spec === undefined) return 'unknown-capability'
    if (driver !== spec.driver) return 'driver-mismatch'
    if (!spec.supports.includes(schemaVersion)) return 'unsupported-schema'
    return undefined
  }

  /** The drivers of a manifest as `{ name, version, capabilities }`; a v1 manifest is grouped by the ids' drivers. */
  const driversOf = (
    manifest: NodeManifest,
  ): Array<{
    name: string
    version: string
    capabilities: Array<{ id: string; schemaVersion: number }>
  }> => {
    if ('drivers' in manifest) {
      return manifest.drivers.map((d) => ({
        name: d.name,
        version: d.version,
        capabilities: d.capabilities.map((c) => ({ id: c.id, schemaVersion: c.schemaVersion })),
      }))
    }
    const groups = new Map<string, Array<{ id: string; schemaVersion: number }>>()
    for (const id of manifest.capabilities) {
      const name = driverOf(id)
      groups.set(name, [...(groups.get(name) ?? []), { id, schemaVersion: 1 }])
    }
    return [...groups].map(([name, capabilities]) => ({
      name,
      version: V1_DRIVER_VERSION,
      capabilities,
    }))
  }

  return {
    register,
    freeze() {
      frozen = true
    },
    get: (id) => table.get(id),
    list: () => [...table.values()],
    accept(manifest) {
      const drivers = driversOf(manifest)
      const accepted: AcceptedCapability[] = []
      const refused: RefusedCapability[] = []
      for (const driver of drivers) {
        for (const { id, schemaVersion } of driver.capabilities) {
          const reason = refusalOf(id, driver.name, schemaVersion)
          if (reason !== undefined) refused.push({ id, schemaVersion, reason })
          // an id announced twice keeps its first entry
          else if (!accepted.some((a) => a.id === id))
            accepted.push({ id, schemaVersion, driver: driver.name })
        }
      }
      return {
        drivers: drivers.map(({ name, version }) => ({ name, version })),
        accepted,
        refused,
      }
    },
  }
}

/** Reads a stored manifest (`nodes.manifest`, JSON) and accepts it; a value that does not parse accepts nothing. */
export function acceptStored(registry: NodeCapabilityRegistry, stored: unknown): Acceptance {
  const parsed = NodeManifestSchema.safeParse(stored)
  if (!parsed.success) return { drivers: [], accepted: [], refused: [] }
  return registry.accept(parsed.data)
}

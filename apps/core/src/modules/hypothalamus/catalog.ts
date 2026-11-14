// The active protocols the triggers read (docs/specs/hypothalamus.md, "Tick"). The set is cached in memory: the protocol
// service calls `changed()` after every write that moves an enabled version (save, enable or disable, delete, a removed
// person), and the next read loads it again. So an idle tick reads no protocol row. A pause does not change the set: the
// engine decides it (`RunStarter` answers `refused`).
import { ProtocolDefinitionSchema } from '@keith/contracts'
import type { ProtocolsRepo } from '@keith/db'
import type { ActiveProtocol, ProtocolCatalog } from './triggers.ts'

export interface ProtocolCatalogHandle extends ProtocolCatalog {
  /** Drops the cached set: the next `active()` reads the enabled protocols again. */
  changed(): void
}

export interface ProtocolCatalogDeps {
  protocols: Pick<ProtocolsRepo, 'list' | 'version'>
  warn(message: string): void
}

/** The enabled protocols with the definition of their current version; a version that does not parse is left out. */
export function createProtocolCatalog(deps: ProtocolCatalogDeps): ProtocolCatalogHandle {
  let cached: ActiveProtocol[] | undefined

  const load = (): ActiveProtocol[] => {
    const out: ActiveProtocol[] = []
    for (const protocol of deps.protocols.list().filter((p) => p.enabled)) {
      const version = deps.protocols.version(protocol.id, protocol.version)
      if (version === undefined) continue
      try {
        const definition = ProtocolDefinitionSchema.parse(JSON.parse(version.definition))
        out.push({
          id: protocol.id,
          version: protocol.version,
          owner: protocol.owner,
          builtIn: protocol.builtIn,
          savedAt: version.savedAt,
          trigger: definition.trigger,
        })
      } catch (error) {
        deps.warn(`protocol ${protocol.id} v${protocol.version} is not readable: ${String(error)}`)
      }
    }
    return out
  }

  return {
    async active() {
      if (cached === undefined) cached = load()
      return cached
    },
    changed() {
      cached = undefined
    },
  }
}

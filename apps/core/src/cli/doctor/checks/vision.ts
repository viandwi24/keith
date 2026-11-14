import type { Node } from '@keith/contracts'
import { openOfflineAdmin } from '../../../modules/admin/index.ts'
import { type CliDeps, connectLocal } from '../../context.ts'
import type { Check, DoctorCheck } from '../types.ts'

/** What the vision line is made of: the cortex model, its input modalities (undefined = the catalog does not know) and the desktop nodes. */
export interface VisionFacts {
  cortex: string | null
  inputModalities: readonly string[] | undefined
  desktopNodes: readonly string[]
}

/**
 * Worker vision (docs/specs/node-drivers.md, Driver desktop): a screenshot only helps a worker whose model reads images. A
 * text-only cortex model with a desktop node is a `!`. An unknown model says nothing: nothing is known to warn about.
 */
export function visionLines(facts: VisionFacts): Check[] {
  if (facts.cortex === null || facts.desktopNodes.length === 0) return []
  if (facts.inputModalities === undefined) return []
  const nodes = facts.desktopNodes.join(', ')
  if (facts.inputModalities.includes('image'))
    return [
      {
        level: 'ok',
        name: 'vision',
        hint: `cortex ${facts.cortex} reads images (desktop: ${nodes})`,
      },
    ]
  return [
    {
      level: 'warn',
      name: 'vision',
      hint: `cortex model ${facts.cortex} is text only, so desktop screenshots on ${nodes} will not be read: keith-core model set cortex <id> with an image model`,
    },
  ]
}

/** Names of the nodes that announce a `desktop.*` capability, asked of the running core (empty when it does not answer). */
async function desktopNodesOf(deps: CliDeps): Promise<string[]> {
  try {
    const { client } = await connectLocal(deps, { prompt: false })
    const nodes: Node[] = await client.rpc.nodes.list()
    return nodes
      .filter((node) => node.capabilities.some((id) => id.startsWith('desktop.')))
      .map((node) => node.name)
  } catch {
    return []
  }
}

/** Only when the core answers on its socket and a desktop node exists: the cortex model and its modalities from the catalog. */
export const visionCheck: DoctorCheck = async ({ config, deps, checks }) => {
  if (checks.find((c) => c.name === 'socket')?.level !== 'ok') return []
  const desktopNodes = await desktopNodesOf(deps)
  if (desktopNodes.length === 0) return []
  const admin = await openOfflineAdmin(config, { ...deps.offline, readOnly: true }).catch(
    () => undefined,
  )
  if (admin === undefined) return []
  try {
    const cortex = (await admin.providers.roles()).cortex
    let inputModalities: readonly string[] | undefined
    if (cortex !== null) {
      try {
        const catalog = admin.providers.catalog()
        const info =
          typeof catalog === 'function'
            ? catalog(admin.providers.manager.resolve(cortex))
            : undefined
        inputModalities = info?.inputModalities
      } catch {
        inputModalities = undefined
      }
    }
    return visionLines({ cortex, inputModalities, desktopNodes })
  } finally {
    admin.close()
  }
}

import type { Node } from '@keith/contracts'
import { type CliDeps, connectLocal } from '../../context.ts'
import type { Check, DoctorCheck } from '../types.ts'

/** The line that says code cannot run: the core never runs code for a worker (ADR-0021 §3). */
export const NO_SANDBOX_HINT =
  'no sandbox node: code cannot run (the core never runs code for a worker)'

/**
 * Sandbox nodes (docs/specs/node-drivers.md, Driver sandbox): one `ok` line per online node that announces `sandbox.run`,
 * or one `!` line when there is none. Pure: the rows come from `nodes.list`, the same rows as the Nodes section.
 */
export function sandboxLines(nodes: readonly Node[]): Check[] {
  const online = nodes.filter(
    (node) => node.status === 'online' && node.capabilities.includes('sandbox.run'),
  )
  if (online.length === 0) return [{ level: 'warn', name: 'sandbox', hint: NO_SANDBOX_HINT }]
  return online.map((node) => ({
    level: 'ok',
    name: 'sandbox',
    hint: `node ${node.name} online`,
  }))
}

/** Only when the core answers on its socket (the `socket` check ran just before). */
export const sandboxCheck: DoctorCheck = async ({ deps, checks }) => {
  if (checks.find((c) => c.name === 'socket')?.level !== 'ok') return []
  return await sandboxLinesOf(deps)
}

async function sandboxLinesOf(deps: CliDeps): Promise<Check[]> {
  try {
    const { client } = await connectLocal(deps, { prompt: false })
    return sandboxLines(await client.rpc.nodes.list())
  } catch (error) {
    return [
      {
        level: 'warn',
        name: 'sandbox',
        hint: `could not ask the core (${error instanceof Error ? error.message : 'unknown'})`,
      },
    ]
  }
}

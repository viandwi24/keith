import type { Node } from '@keith/contracts'
import { AdminSessionRequiredError } from '../../admin-session.ts'
import { type CliDeps, connectLocal } from '../../context.ts'
import type { Check, DoctorCheck } from '../types.ts'

/**
 * One line per node (docs/specs/node-drivers.md, "Doctor"): its drivers as the TUI shows them (`desktop 0.1.0 · screenshot
 * input`, the capabilities without the driver prefix) and each refused capability. A refusal is a `!`, never a `✗`.
 * Pure: the lines come from the rows the core answers with (`nodes.list`), so they match the Nodes section.
 */
export function driverLines(nodes: readonly Node[]): Check[] {
  return nodes.map((node) => {
    const drivers = node.drivers.map((driver) => {
      const prefix = `${driver.name}.`
      const caps = node.capabilities
        .filter((id) => id.startsWith(prefix))
        .map((id) => id.slice(prefix.length))
      return `${driver.name} ${driver.version}${caps.length > 0 ? ` · ${caps.join(' ')}` : ''}`
    })
    const refused = node.refused.map((r) => `refused ${r.id} (${r.reason})`)
    const parts = [...drivers, ...refused]
    return {
      level: node.refused.length > 0 ? 'warn' : 'ok',
      name: `node ${node.name}`,
      hint: parts.length > 0 ? parts.join('; ') : 'no drivers announced',
    }
  })
}

/**
 * The node drivers, asked of the running core over its socket (`nodes.list`, the same rows as the TUI). A locked socket
 * or one that needs an admin session is a `!` note, never a `✗`; doctor never prompts (core-cli.md).
 */
export async function nodeDriversCheck(deps: CliDeps): Promise<Check[]> {
  try {
    const { client } = await connectLocal(deps, { prompt: false })
    return driverLines(await client.rpc.nodes.list())
  } catch (error) {
    if (error instanceof AdminSessionRequiredError)
      return [{ level: 'warn', name: 'node drivers', hint: error.message }]
    return [
      {
        level: 'warn',
        name: 'node drivers',
        hint: `could not ask the core (${error instanceof Error ? error.message : 'unknown'})`,
      },
    ]
  }
}

/** Only when the core answers on its socket (the `socket` check ran just before). */
export const driversTableCheck: DoctorCheck = async ({ deps, checks }) =>
  checks.find((c) => c.name === 'socket')?.level === 'ok' ? nodeDriversCheck(deps) : []

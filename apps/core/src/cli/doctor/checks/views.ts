import { AdminSessionRequiredError } from '../../admin-session.ts'
import { type CliDeps, connectLocal } from '../../context.ts'
import type { Check, DoctorCheck } from '../types.ts'

/**
 * The plugin terminal views open now, asked of the running core over its socket (`admin.plugins.views`): the view,
 * the person and how long it has been open: never what it shows. A locked socket or one that needs a session says so
 * and the check is a note, not a failure. Doctor never prompts for the owner PIN (`prompt: false`, core-cli.md).
 */
export async function viewsCheck(deps: CliDeps): Promise<Check> {
  try {
    const { client } = await connectLocal(deps, { prompt: false })
    const open = await client.rpc.admin.plugins.views.list()
    if (open.length === 0) return { level: 'ok', name: 'plugin views', hint: 'none open' }
    const now = Date.now()
    const lines = open.map(
      (v) =>
        `${v.viewId} for ${v.personId} (${Math.max(0, Math.round((now - v.openedAt) / 1000))} s)`,
    )
    return { level: 'ok', name: 'plugin views', hint: `${open.length} open: ${lines.join(', ')}` }
  } catch (error) {
    if (error instanceof AdminSessionRequiredError)
      return { level: 'warn', name: 'plugin views', hint: error.message }
    return {
      level: 'warn',
      name: 'plugin views',
      hint: `could not ask the core (${error instanceof Error ? error.message : 'unknown'})`,
    }
  }
}

/** Only when the core answers on its socket (the `socket` check ran just before). */
export const viewsTableCheck: DoctorCheck = async ({ deps, checks }) =>
  checks.find((c) => c.name === 'socket')?.level === 'ok' ? [await viewsCheck(deps)] : []

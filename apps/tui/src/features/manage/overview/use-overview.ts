import type { ManageEnv, SectionData } from '../manage-types.ts'
import { useLoad } from '../use-load.ts'
import { type OverviewInput, overviewLines } from './overview-state.ts'

/** Overview: one screen of facts; each call is optional (a member lacks some of them). */
export function useOverview(env: ManageEnv): SectionData {
  const { client, caps, me, nodes } = env
  const load = useLoad<Omit<OverviewInput, 'me' | 'nodes'>>(async () => {
    const [health, roles, budget, people, devices] = await Promise.all([
      client.rpc.health.get().catch(() => undefined),
      caps.has('settings.read') ? client.rpc.models.roles.get().catch(() => undefined) : undefined,
      caps.has('budget.read') ? client.rpc.budget.get().catch(() => undefined) : undefined,
      caps.has('people.manage') ? client.rpc.admin.people.list().catch(() => undefined) : undefined,
      caps.has('devices.manage')
        ? client.rpc.admin.devices.list().catch(() => undefined)
        : undefined,
    ])
    return {
      health,
      roles,
      budget,
      people: people?.length,
      pendingDevices: devices?.pending.length,
    }
  })
  const data = load.data
  return {
    lines:
      data === undefined
        ? []
        : overviewLines({ ...data, me, nodes: caps.has('nodes.read') ? nodes.nodes : undefined }),
    rows: [],
    actions: [],
    error: load.error,
    loading: load.loading,
    reload: load.reload,
  }
}

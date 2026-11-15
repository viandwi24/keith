import { type OverviewInput, overviewLines } from './overview-state.ts'
import type { SectionEnv, SectionModel } from './types.ts'

/** Overview: one screen of facts; each call is optional (a member lacks some of them). */
export function overviewSection(env: SectionEnv) {
  const { client, caps, me } = env
  const load = async () => {
    const [health, roles, budget, people, devices] = await Promise.all([
      client.rpc.health.get().catch(() => undefined),
      caps.has('settings.read') ? client.rpc.models.roles.get().catch(() => undefined) : undefined,
      caps.has('budget.read') ? client.rpc.budget.get().catch(() => undefined) : undefined,
      caps.has('people.manage') ? client.rpc.admin.people.list().catch(() => undefined) : undefined,
      caps.has('devices.manage')
        ? client.rpc.admin.devices.list().catch(() => undefined)
        : undefined,
    ])
    const nodes = caps.has('nodes.read')
      ? (env.nodes ?? (await client.rpc.nodes.list().catch(() => undefined)))
      : undefined
    return {
      health,
      roles,
      budget,
      people: people?.length,
      pendingDevices: devices?.pending.length,
      nodes,
    }
  }
  return { load, build: buildBody } satisfies SectionModel<Awaited<ReturnType<typeof load>>>

  function buildBody(data: Awaited<ReturnType<typeof load>> | undefined) {
    return {
      lines:
        data === undefined
          ? []
          : overviewLines({
              ...data,
              me,
              nodes: caps.has('nodes.read') ? (env.nodes ?? data.nodes) : undefined,
            } satisfies OverviewInput),
      rows: [],
      actions: [],
    }
  }
}

import { createAction, groupActions } from './groups-actions.ts'
import { GROUPS_HEADER, GROUPS_WIDTHS, groupRow } from './groups-state.ts'
import type { SectionEnv, SectionModel } from './types.ts'

/** Groups: who is in each group the owner shares with (`admin.groups.list`); owner only. */
export function groupsSection(env: SectionEnv) {
  const { client } = env
  return {
    load: async () => {
      const [groups, people] = await Promise.all([
        client.rpc.admin.groups.list(),
        // the person picker; a member granted only groups.manage may lack people.manage
        client.rpc.admin.people.list().catch(() => []),
      ])
      return { groups, people }
    },
    build: (d) => ({
      lines: [],
      header: GROUPS_HEADER,
      widths: GROUPS_WIDTHS,
      rows: (d?.groups ?? []).map((g) => groupRow(g, groupActions(client, g, d?.people ?? []))),
      empty: 'No groups yet. Create one to share with.',
      actions: [createAction(client)],
    }),
  } satisfies SectionModel<{
    groups: Awaited<ReturnType<typeof client.rpc.admin.groups.list>>
    people: Awaited<ReturnType<typeof client.rpc.admin.people.list>>
  }>
}

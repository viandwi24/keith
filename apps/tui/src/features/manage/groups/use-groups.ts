import type { ManageEnv, SectionData } from '../manage-types.ts'
import { useLoad } from '../use-load.ts'
import { createAction, groupActions } from './groups-actions.ts'
import { GROUPS_HEADER, GROUPS_WIDTHS, groupRow } from './groups-state.ts'

/** Groups: who is in each group the owner shares with (`admin.groups.list`); owner only. */
export function useGroups(env: ManageEnv): SectionData {
  const { client } = env
  const load = useLoad(async () => {
    const [groups, people] = await Promise.all([
      client.rpc.admin.groups.list(),
      // the person picker; a member granted only groups.manage may lack people.manage
      client.rpc.admin.people.list().catch(() => []),
    ])
    return { groups, people }
  })
  const groups = load.data?.groups ?? []
  const people = load.data?.people ?? []
  return {
    lines: [],
    header: GROUPS_HEADER,
    widths: GROUPS_WIDTHS,
    rows: groups.map((g) => groupRow(g, groupActions(client, g, people))),
    empty: 'No groups yet. Press n to create one.',
    actions: [createAction(client)],
    error: load.error,
    loading: load.loading,
    reload: load.reload,
  }
}

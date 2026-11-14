import type { ManageEnv, SectionData } from '../manage-types.ts'
import { useLoad } from '../use-load.ts'
import { addAction, personActions } from './people-actions.ts'
import { PEOPLE_HEADER, PEOPLE_WIDTHS, personRow } from './people-state.ts'

/** People: every person, newest change first (`admin.people.list`). */
export function usePeople(env: ManageEnv): SectionData {
  const list = useLoad(async () => {
    const [people, capabilities] = await Promise.all([
      env.client.rpc.admin.people.list(),
      // the grant picker: core ids plus the ones loaded plugins registered; an older core has no such call
      env.client.rpc.admin.capabilities
        .list()
        .then((all) => all.filter((c) => !c.ownerOnly).map((c) => c.id))
        .catch(() => undefined),
    ])
    return { people, capabilities }
  })
  const people = list.data?.people ?? []
  const capabilities = list.data?.capabilities
  return {
    lines: [],
    header: PEOPLE_HEADER,
    widths: PEOPLE_WIDTHS,
    rows: people.map((p) =>
      personRow(p, personActions(env.client, p, capabilities, env.me.role === 'owner')),
    ),
    empty: 'No people yet.',
    actions: [addAction(env.client)],
    error: list.error,
    loading: list.loading,
    reload: list.reload,
  }
}

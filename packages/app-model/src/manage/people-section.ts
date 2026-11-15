import { addAction, personActions } from './people-actions.ts'
import { PEOPLE_HEADER, PEOPLE_WIDTHS, personRow } from './people-state.ts'
import type { SectionEnv, SectionModel } from './types.ts'

/** People: every person, newest change first (`admin.people.list`). */
export function peopleSection(env: SectionEnv) {
  const { client } = env
  return {
    load: async () => {
      const [people, capabilities] = await Promise.all([
        client.rpc.admin.people.list(),
        // the grant picker: core ids plus the ones loaded plugins registered; an older core has no such call
        client.rpc.admin.capabilities
          .list()
          .then((all) => all.filter((c) => !c.ownerOnly).map((c) => c.id))
          .catch(() => undefined),
      ])
      return { people, capabilities }
    },
    build: (d) => ({
      lines: [],
      header: PEOPLE_HEADER,
      widths: PEOPLE_WIDTHS,
      rows: (d?.people ?? []).map((p) =>
        personRow(p, personActions(client, p, d?.capabilities, env.me.role === 'owner')),
      ),
      empty: 'No people yet.',
      actions: [addAction(client)],
    }),
  } satisfies SectionModel<{
    people: Awaited<ReturnType<typeof client.rpc.admin.people.list>>
    capabilities: string[] | undefined
  }>
}

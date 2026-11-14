import type { KeithClient } from '@keith/client'
import type { GroupView, Person } from '@keith/contracts'
import type { ActionSpec } from '../manage-types.ts'
import { addable, memberLabel } from './groups-state.ts'

/** Create a group (`admin.groups.create`, the same call as `keith-core groups create`). */
export function createAction(client: KeithClient): ActionSpec {
  return {
    id: 'groups.create',
    label: 'Create a group',
    hint: 'lowercase letters, digits, . _ -',
    fields: [{ id: 'name', label: 'Name', placeholder: 'friends' }],
    run: async (v) => {
      const group = await client.rpc.admin.groups.create({ name: (v.name ?? '').trim() })
      return { message: `group ${group.name} created` }
    },
  }
}

/** Every action on one group; each is one `client.rpc.admin.groups.*` call. */
export function groupActions(
  client: KeithClient,
  g: GroupView,
  people: readonly Person[],
): ActionSpec[] {
  const api = client.rpc.admin.groups
  const actions: ActionSpec[] = []
  const free = addable(g, people)
  if (free.length > 0)
    actions.push({
      id: 'groups.add',
      label: 'Add a member',
      hint: 'pick from the people',
      fields: [{ id: 'person', label: 'Person', options: free }],
      run: async (v) => {
        const person = v.person ?? ''
        const done = await api.add({ group: g.id, person })
        return { message: `${person} added to ${done.name} (${done.members.length} members)` }
      },
    })
  if (g.members.length > 0)
    actions.push({
      id: 'groups.remove',
      label: 'Remove a member',
      fields: [{ id: 'person', label: 'Person', options: g.members.map(memberLabel) }],
      run: async (v) => {
        const person = v.person ?? ''
        const done = await api.remove({ group: g.id, person })
        return { message: `${person} removed from ${done.name} (${done.members.length} members)` }
      },
    })
  actions.push({
    id: 'groups.delete',
    label: 'Delete',
    hint: 'refused while a resource uses it',
    confirm: {
      text:
        g.usage > 0
          ? `Delete ${g.name}? ${g.usage} resource${g.usage === 1 ? ' uses' : 's use'} it: the core will refuse until they are unshared.`
          : `Delete ${g.name}? Its members lose the access it gave them.`,
    },
    run: async () => {
      await api.delete({ group: g.id })
      return { message: `group ${g.name} deleted` }
    },
  })
  return actions
}

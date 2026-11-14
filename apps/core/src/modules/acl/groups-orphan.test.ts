import { describe, expect, test } from 'bun:test'
import { memoryAcl } from '@keith/acl'
import { createGroupsService } from './groups.ts'

describe('a group member who is no person', () => {
  test('is listed as removed, grants nothing, and can still be taken off the list', async () => {
    const acl = memoryAcl({ kinds: [] } as never)
    acl.createGroup({ id: 'g1', name: 'friends', createdBy: 'owner' })
    acl.addMember('g1', 'ghost', 'owner')
    const people = {
      get: async (ref: string) => {
        throw new Error(`no person ${ref}`)
      },
    }
    const groups = createGroupsService({
      acl: acl as never,
      people: people as never,
      audit: { record: () => {} } as never,
    })
    const view = await groups.get('g1')
    expect(view.members).toEqual([
      { id: 'ghost', username: null, name: 'ghost', status: 'removed' },
    ])
    const after = await groups.remove('g1', 'ghost', { by: 'owner', via: 'local' } as never)
    expect(after.members).toEqual([])
  })
})

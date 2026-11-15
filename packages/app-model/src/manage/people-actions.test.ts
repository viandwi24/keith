import { describe, expect, test } from 'bun:test'
import type { KeithClient } from '@keith/client'
import type { Person } from '@keith/contracts'
import { personActions } from './people-actions.ts'

const ana: Person = {
  id: '0190-ana-id',
  username: 'ana',
  name: 'Ana',
  role: 'member',
  status: 'active',
  canLogin: true,
  createdBy: null,
  createdAt: 0,
  updatedAt: 0,
}

/** A client whose `admin.people` calls are recorded; every call answers the person (grants: the list). */
function recordingClient() {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = []
  const record =
    (method: string) =>
    async (input: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, input })
      // grants answer the capability list; everything else answers the person
      return method.includes('rant') ? ['notify'] : { ...ana, ...input, id: ana.id }
    }
  const people = new Proxy(
    {},
    {
      get: (_target, method: string) => record(method),
    },
  )
  const client = { rpc: { admin: { people } } } as unknown as KeithClient
  return { client, calls }
}

function actionRun(client: KeithClient, id: string, person: Person = ana) {
  const actions = personActions(client, person, ['notify'])
  const action = actions.find((a) => a.id === id)
  if (action === undefined) throw new Error(`no action ${id}`)
  return action
}

describe('people actions address the person by id', () => {
  test('a suspend after a rename still names the stable id, not the old username', async () => {
    const { client, calls } = recordingClient()
    await actionRun(client, 'people.suspend').run({})
    expect(calls).toEqual([{ method: 'suspend', input: { person: ana.id } }])
  })

  test('a rename names the id; the message still shows the username', async () => {
    const { client, calls } = recordingClient()
    const result = await actionRun(client, 'people.rename').run({ username: 'ana2' })
    expect(calls[0]).toEqual({
      method: 'rename',
      input: { person: ana.id, username: 'ana2' },
    })
    expect(result?.message).toContain('ana2')
  })

  test('a grant and a password change name the id', async () => {
    const { client, calls } = recordingClient()
    await actionRun(client, 'people.grant').run({ capability: 'notify' })
    await actionRun(client, 'people.password').run({
      password: 'a-long-passphrase',
      repeat: 'a-long-passphrase',
    })
    expect(calls.map((c) => c.input.person)).toEqual([ana.id, ana.id])
  })
})

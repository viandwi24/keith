import { afterAll, describe, expect, test } from 'bun:test'
import { createKeithClient, type KeithClient } from '@keith/client'
import { cleanup, send } from '../../testing/core-harness.ts'
import { issueOwnerToken } from '../../testing/owner-token.ts'
import { type Booted, baseUrl, scenario } from '../../testing/scenario-harness.ts'
import { CLIENT_CALL_DESCRIPTION } from '../parietal/index.ts'

// audit F9 (docs/specs/parietal.md, node-drivers.md): the `client_call` description is fixed; the apps online for the person
// are a line of the turn reminder. Real core, scripted model.

afterAll(cleanup)

const configOf = (dataDir: string) => ({ dataDir, dbFile: `${dataDir}/keith.db` }) as never

async function addMember(r: Booted, dataDir: string, username: string) {
  const person = await r.client.rpc.admin.people.add({ username })
  const token = await issueOwnerToken(configOf(dataDir), username, { personId: person.id })
  return { id: person.id, client: createKeithClient({ baseUrl: baseUrl(r), token }) }
}

const say = async (client: KeithClient, text: string, session: string) => {
  for await (const _ of client.reply(text, session)) {
    // drain: the stream ends with the turn
  }
}

const ENV = {
  host: 'ana-mbp',
  os: 'macos' as const,
  osVersion: '16.0',
  arch: 'arm64',
  device: 'laptop' as const,
  timezone: 'Asia/Jakarta',
}
const APP_1 = '00000000-0000-4000-8000-0000000000a1'
const APP_2 = '00000000-0000-4000-8000-0000000000a2'

describe('front agent: apps online', () => {
  test('the client_call description never changes; the reminder line follows the apps online', async () => {
    const s = await scenario({
      front: [
        { text: 'owner' },
        { text: 'none yet' },
        { text: 'one app' },
        { text: 'two apps' },
      ] as never,
    })
    const ana = await addMember(s.r, s.dataDir, 'ana')

    await send(s.r.client, 'hi')
    await say(ana.client, 'first', `front:${ana.id}`)
    await ana.client.rpc.presence.clients.register({
      id: APP_1,
      kind: 'tui',
      label: 'ana-mbp',
      capabilities: ['chat', 'notify'],
      version: '0.1.0',
      environment: ENV,
    })
    await say(ana.client, 'second', `front:${ana.id}`)
    await ana.client.rpc.presence.clients.register({
      id: APP_2,
      kind: 'tui',
      label: 'ana-phone',
      capabilities: ['chat', 'open.view'],
      version: '0.1.0',
      environment: ENV,
    })
    await say(ana.client, 'third', `front:${ana.id}`)

    const calls = s.front.models.get('f')?.calls ?? []
    // the function tools of each call; a provider tool has no description, so it is read as the function kind
    const descriptions = calls.map(
      (c) =>
        (c.tools ?? []).filter((t) => t.type === 'function').find((t) => t.name === 'client_call')
          ?.description,
    )
    expect(descriptions.length).toBe(4)
    for (const d of descriptions) expect(d).toBe(CLIENT_CALL_DESCRIPTION)

    const [forOwner, forNone, forOne, forTwo] = (s.front.models.get('f')?.prompts ?? []).map((p) =>
      JSON.stringify(p),
    )
    expect(forOwner).toContain('Apps online now: none.')
    expect(forNone).toContain('Apps online now: none.')
    expect(forOne).toContain('Apps online now: notify. ')
    expect(forOne).not.toContain('open.view')
    expect(forTwo).toContain('Apps online now: notify, open.view. ')
    expect(forTwo).not.toContain('Apps online now: none')
  })
})

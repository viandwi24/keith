import { afterAll, describe, expect, test } from 'bun:test'
import { createKeithClient, type KeithClient } from '@keith/client'
import { cleanup, send } from '../../testing/core-harness.ts'
import { issueOwnerToken } from '../../testing/owner-token.ts'
import { type Booted, baseUrl, scenario } from '../../testing/scenario-harness.ts'

// docs/decisions/0033 §5 and docs/specs/prefrontal.md "Front turn": the "Where the person is now" block is in the turn reminder
// of the person whose client is online, and only there. Real core, scripted model.

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

const CLIENT = '00000000-0000-4000-8000-0000000000c1'
const ENV = {
  host: 'ana-mbp',
  os: 'macos' as const,
  osVersion: '16.0',
  arch: 'arm64',
  device: 'laptop' as const,
  timezone: 'Asia/Jakarta',
}

describe('front agent: where the person is now', () => {
  test('the block is in the reminder of the person whose client is online, and never in another person’s', async () => {
    const s = await scenario({
      front: [{ text: 'owner answer' }, { text: 'ana answer' }, { text: 'ana again' }] as never,
    })
    const member = await addMember(s.r, s.dataDir, 'ana')
    await member.client.rpc.presence.clients.register({
      id: CLIENT,
      kind: 'tui',
      label: 'ana-mbp',
      capabilities: ['chat', 'notify', 'open.view'],
      version: '0.1.0',
      environment: ENV,
    })

    await send(s.r.client, 'hi')
    await say(member.client, 'where am I', `front:${member.id}`)

    const [forOwner, forAna] = (s.front.models.get('f')?.prompts ?? []).map((p) =>
      JSON.stringify(p),
    )
    expect(forAna).toContain('Where the person is now')
    expect(forAna).toContain('host \\"ana-mbp\\"')
    expect(forAna).toContain('Network: loopback.')
    expect(forAna).toContain('Local time:')
    expect(forAna).toContain('No location sensor is online')
    // the owner has no client online: no block, and nothing of ana's client reaches the owner's reminder
    expect(forOwner).not.toContain('Where the person is now')
    expect(forOwner).not.toContain('ana-mbp')
  })

  test('the block needs no setting: an active client gets it, and a person with no client gets none', async () => {
    const s = await scenario({
      front: [{ text: 'first' }, { text: 'second' }] as never,
    })
    const member = await addMember(s.r, s.dataDir, 'ana')
    await member.client.rpc.presence.clients.register({
      id: CLIENT,
      kind: 'tui',
      label: 'ana-mbp',
      capabilities: ['chat', 'notify'],
      version: '0.1.0',
      environment: ENV,
    })
    const ben = await addMember(s.r, s.dataDir, 'ben')

    await say(member.client, 'where am I', `front:${member.id}`)
    await say(ben.client, 'where am I', `front:${ben.id}`)

    const [forAna, forBen] = (s.front.models.get('f')?.prompts ?? []).map((p) => JSON.stringify(p))
    expect(forAna).toContain('Where the person is now')
    expect(forAna).toContain('host \\"ana-mbp\\"')
    expect(forAna).toContain('No location sensor is online')
    expect(forBen).not.toContain('The person is using')
    expect(forBen).not.toContain('Where the person is now')
  })
})

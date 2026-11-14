/**
 * P28.5.5: the isolation proof of the protocol layer (ADR-0020 §2, docs/specs/hypothalamus.md "Invariants"). Member ana has a
 * protocol, a proposal from her agenda and an agenda item; member ben then asks the front agent what he has, through his own
 * protocol and agenda tools. Ben's model context (every prompt of his turn) holds none of ana's text, ids or proposals: only
 * his own rows. Real core, a scripted front model, the owner and two members.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { createKeithClient, type KeithClient } from '@keith/client'
import { cleanup, stop } from './testing/core-harness.ts'
import { issueOwnerToken } from './testing/owner-token.ts'
import { baseUrl, type Scenario, scenario } from './testing/scenario-harness.ts'

const HOUR = 3_600_000
const MEETING_AT = Date.UTC(2031, 0, 10, 9, 0)
const MEETING_END = Date.UTC(2031, 0, 10, 10, 0)
const ANA_TEXT = 'ANA-PROTOCOL-TEXT'
const ANA_REASON = 'ANA-SUGGESTION-REASON'
const ANA_WHAT = 'ANA-BOARD-SECRET'
const ANA_PLACE = 'ANA-ROOM-SECRET'
const BEN_TEXT = 'BEN-OWN-TEXT'

const configOf = (dataDir: string) => ({ dataDir, dbFile: `${dataDir}/keith.db` }) as never

async function addMember(s: Scenario, username: string) {
  const person = await s.r.client.rpc.admin.people.add({ username })
  const token = await issueOwnerToken(configOf(s.dataDir), username, { personId: person.id })
  return {
    id: person.id,
    client: createKeithClient({ baseUrl: baseUrl(s.r), token }) as KeithClient,
  }
}

/** A one-step reminder: a time trigger and one notify with a fixed text. */
const reminder = (text: string) => ({
  trigger: { kind: 'time' as const, at: Date.now() + 2 * HOUR },
  steps: [{ id: 'say', kind: 'notify' as const, to: 'owner-of-run' as const, text }],
  start: 'say',
})

describe('protocols, runs, proposals and agenda of one person never enter another person model context', () => {
  let s: Scenario

  afterAll(async () => {
    await stop(s.r)
    cleanup()
  })
  let ana: Awaited<ReturnType<typeof addMember>>
  let ben: Awaited<ReturnType<typeof addMember>>

  test('setup: ana makes a protocol, a meeting and a suggestion; ben makes his own protocol', async () => {
    s = await scenario({
      front: [
        // ana: a meeting with a place (the agenda rule proposes "keep quiet" for it)
        {
          toolCalls: [
            {
              toolName: 'agenda_add',
              toolCallId: 'a-1',
              input: {
                what: ANA_WHAT,
                startsAt: new Date(MEETING_AT).toISOString(),
                endsAt: new Date(MEETING_END).toISOString(),
                place: ANA_PLACE,
                status: 'confirmed',
              },
            },
          ],
        },
        { text: 'Noted.' },
        // ana: a standing rule she asks for (a proposal, never a protocol)
        {
          toolCalls: [
            {
              toolName: 'protocol_propose',
              toolCallId: 'p-1',
              input: { reason: ANA_REASON, definition: reminder(ANA_TEXT) },
            },
          ],
        },
        { text: 'Suggested; it waits for you.' },
        // ben: asks what he has
        { toolCalls: [{ toolName: 'protocol_list', toolCallId: 'l-1', input: {} }] },
        { toolCalls: [{ toolName: 'agenda_list', toolCallId: 'g-1', input: {} }] },
        { text: 'Nothing else is planned.' },
      ] as never,
    })
    ana = await addMember(s, 'ana')
    ben = await addMember(s, 'ben')
    await ana.client.rpc.protocols.save({ name: 'ana-ladder', definition: reminder(ANA_TEXT) })
    await ben.client.rpc.protocols.save({ name: 'ben-ladder', definition: reminder(BEN_TEXT) })
    for await (const _ of ana.client.reply(
      'I have a board meeting at 9 in room 2',
      `front:${ana.id}`,
    )) {
      // drain
    }
    for await (const _ of ana.client.reply('suggest a standing rule', `front:${ana.id}`)) {
      // drain
    }
    expect((await ana.client.rpc.agenda.list({})).items).toHaveLength(1)
    expect((await ana.client.rpc.protocols.proposals()).proposals).toHaveLength(2)
  }, 60_000)

  test("ben's turn: his model context holds his own rows only", async () => {
    const anaSecrets = [
      ANA_TEXT,
      ANA_REASON,
      ANA_WHAT,
      ANA_PLACE,
      'ana-ladder',
      ...(await ana.client.rpc.protocols.list()).protocols.map((p) => p.id),
      ...(await ana.client.rpc.protocols.proposals()).proposals.map((p) => p.id),
      ...(await ana.client.rpc.agenda.list({})).items.map((i) => i.id),
    ]
    const frontBefore = s.front.models.get('f')?.prompts.length ?? 0
    for await (const _ of ben.client.reply('what do I have planned?', `front:${ben.id}`)) {
      // drain
    }
    const context = JSON.stringify((s.front.models.get('f')?.prompts ?? []).slice(frontBefore))
    // the capture is real: ben's own protocol is in it
    expect(context).toContain('ben-ladder')
    for (const secret of anaSecrets) {
      expect(context).not.toContain(secret)
    }
    // and ben's own list answers only his rows
    const own = (await ben.client.rpc.protocols.list()).protocols.map((p) => p.name)
    expect(own).toEqual(['ben-ladder'])
    expect((await ben.client.rpc.agenda.list({})).items).toEqual([])
  }, 60_000)
})

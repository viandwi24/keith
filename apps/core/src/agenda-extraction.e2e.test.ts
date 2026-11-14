/**
 * P28.5.2: the front agent stores an agenda item only for a time the person said (ADR-0025 §2, docs/specs/hypothalamus.md
 * "Agenda"). Real core, a scripted front model, the owner and one member. A clear time is stored as `confirmed`; a vague
 * one asks first and stores nothing before the answer; the tool writes for the turn's person and no one else.
 */
import { describe, expect, test } from 'bun:test'
import { createKeithClient, type KeithClient } from '@keith/client'
import { stop } from './testing/core-harness.ts'
import { issueOwnerToken } from './testing/owner-token.ts'
import { baseUrl, scenario } from './testing/scenario-harness.ts'

const MEETING_AT = '2026-11-11T09:00:00.000Z'
const MEETING_END = '2026-11-11T10:00:00.000Z'
const ANSWER_AT = '2026-11-12T14:00:00.000Z'

const configOf = (dataDir: string) => ({ dataDir, dbFile: `${dataDir}/keith.db` }) as never

async function addMember(s: Awaited<ReturnType<typeof scenario>>, username: string) {
  const person = await s.r.client.rpc.admin.people.add({ username })
  const token = await issueOwnerToken(configOf(s.dataDir), username, { personId: person.id })
  return {
    id: person.id,
    client: createKeithClient({ baseUrl: baseUrl(s.r), token }) as KeithClient,
  }
}

const addItem = (input: Record<string, unknown>, n: number) => ({
  toolCalls: [{ toolName: 'agenda_add', toolCallId: `add-${n}`, input }],
})

describe('the front agent stores what the person said they will do', () => {
  test('a clear time is stored as confirmed, for the person who said it', async () => {
    const s = await scenario({
      front: [
        addItem(
          { what: 'board meeting', startsAt: MEETING_AT, endsAt: MEETING_END, status: 'confirmed' },
          1,
        ),
        { text: 'Noted: board meeting at 09:00.' },
      ] as never,
    })
    try {
      for await (const _ of s.r.client.reply(
        'I have a board meeting at 9 tomorrow',
        'front:owner',
      )) {
        // drain: the stream ends with the turn
      }
      const items = (await s.r.client.rpc.agenda.list({})).items
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        person: 'owner',
        what: 'board meeting',
        startsAt: Date.parse(MEETING_AT),
        endsAt: Date.parse(MEETING_END),
        status: 'confirmed',
      })
    } finally {
      await stop(s.r)
    }
  }, 30_000)

  test('a vague time asks first and stores nothing before the answer', async () => {
    const s = await scenario({
      front: [
        { text: 'When exactly is it?' },
        addItem({ what: 'dentist', startsAt: ANSWER_AT, status: 'confirmed' }, 2),
        { text: 'Added: dentist on the 12th at 14:00.' },
      ] as never,
    })
    try {
      for await (const _ of s.r.client.reply('dentist sometime next week', 'front:owner')) {
        // drain
      }
      expect((await s.r.client.rpc.agenda.list({})).items).toEqual([])
      for await (const _ of s.r.client.reply('the 12th at 2pm', 'front:owner')) {
        // drain
      }
      const items = (await s.r.client.rpc.agenda.list({})).items
      expect(items.map((i) => [i.what, i.startsAt, i.status])).toEqual([
        ['dentist', Date.parse(ANSWER_AT), 'confirmed'],
      ])
    } finally {
      await stop(s.r)
    }
  }, 30_000)

  test("the tool writes for the turn's person: a member's item is never the owner's", async () => {
    const s = await scenario({
      front: [
        addItem({ what: 'flight to Tennessee', startsAt: MEETING_AT, status: 'confirmed' }, 3),
        { text: 'Noted.' },
      ] as never,
    })
    try {
      const ana = await addMember(s, 'ana')
      for await (const _ of ana.client.reply('I fly to Tennessee at 9', `front:${ana.id}`)) {
        // drain
      }
      expect((await s.r.client.rpc.agenda.list({})).items).toEqual([])
      const mine = (await ana.client.rpc.agenda.list({})).items
      expect(mine.map((i) => [i.person, i.what])).toEqual([[ana.id, 'flight to Tennessee']])
    } finally {
      await stop(s.r)
    }
  }, 30_000)
})

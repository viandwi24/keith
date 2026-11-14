import { describe, expect, test } from 'bun:test'
import { CHAT_CONTEXT_PENDING, ROOM_EVENT, ROOM_INDICATOR } from '@keith/contracts'
import type { ActivityRecord } from 'eharness/activity'
import type { Principal } from '../auth/index.ts'
import { activityFilter } from './activity-filter.ts'

const rec = (type: string, sessionId: string | null, payload: unknown = {}) =>
  ({ seq: 1, type, sessionId, agentId: null, payload, createdAt: 0 }) as unknown as ActivityRecord
const owner: Principal = { personId: 'o1', role: 'owner' }
const ana: Principal = { personId: 'ana', role: 'member' }

describe('activity filter', () => {
  test('a person gets their own front and worker sessions only', () => {
    const f = activityFilter(ana)
    expect(f(rec('brain.broca.start', 'front:ana'))).toBe(true)
    expect(f(rec('brain.cortex.step', 'front:ana:agent:c1'))).toBe(true)
    expect(f(rec('brain.broca.start', 'front:o1'))).toBe(false)
    // every member holds nodes.read: node changes reach them (ADR-0027 §9)
    expect(f(rec('node-changed', null))).toBe(true)
  })

  test('the owner also gets system events and owner-routed waits of others, nothing else of theirs', () => {
    const f = activityFilter(owner)
    expect(f(rec('budget-changed', null))).toBe(true)
    expect(f(rec('node-changed', null))).toBe(true)
    expect(f(rec('brain.broca.start', 'front:o1'))).toBe(true)
    expect(f(rec('brain.thalamus.routed', 'front:ana', { preview: 'hi' }))).toBe(false)
    expect(f(rec('task-changed', 'front:ana'))).toBe(false)
    expect(f(rec('brain.amygdala.wait', 'front:ana:agent:c1', { toolName: 'web_fetch' }))).toBe(
      false,
    )
    expect(f(rec('brain.amygdala.wait', 'front:ana:agent:c1', { toolName: 'motor_remote' }))).toBe(
      true,
    )
  })
})

describe('chat.context.pending on the feed (P34.3.2)', () => {
  test('a context change in progress reaches only the person whose session it is', () => {
    const start = rec(CHAT_CONTEXT_PENDING, 'front:ana', { kind: 'new', state: 'start' })
    expect(activityFilter(ana)(start)).toBe(true)
    expect(activityFilter(owner)(start)).toBe(false)
    expect(activityFilter({ personId: 'ben', role: 'member' })(start)).toBe(false)
  })
})

describe('plugin events on the feed', () => {
  const ev = (to: string) =>
    rec('plugin.notes.shared', null, { plugin: 'notes', event: 'shared', to, data: {} })
  test("a person gets the records addressed to them and to everyone; the owner gets no one else's", () => {
    expect(activityFilter(ana)(ev('ana'))).toBe(true)
    expect(activityFilter(ana)(ev('ben'))).toBe(false)
    expect(activityFilter(ana)(ev('*'))).toBe(true)
    // system records go to the owner, plugin records do not
    expect(activityFilter(owner)(rec('budget-changed', null))).toBe(true)
    expect(activityFilter(owner)(ev('ana'))).toBe(false)
    expect(activityFilter(owner)(ev('o1'))).toBe(true)
    expect(activityFilter(ana)(rec('plugin.notes.shared', null, null))).toBe(false)
  })
})

describe('room records on the feed (corpus-callosum.md "Transport")', () => {
  const roomEvent = (to: string) => rec(ROOM_EVENT, null, { to, roomId: 'r1', seq: 4 })
  const member: Principal = { personId: 'ana', role: 'member' }
  const other: Principal = { personId: 'ben', role: 'member' }

  test('a room.event reaches the person named in to only; a non-member gets none', () => {
    expect(activityFilter(member)(roomEvent('ana'))).toBe(true)
    expect(activityFilter(other)(roomEvent('ana'))).toBe(false)
    expect(activityFilter(other)(roomEvent('ben'))).toBe(true)
    // the owner is not a member: nothing of another person's room line, even though the owner is a system reader
    expect(activityFilter(owner)(roomEvent('ana'))).toBe(false)
    expect(activityFilter(owner)(roomEvent('o1'))).toBe(true)
    // a `*` recipient is not a room rule: room events are never public
    expect(activityFilter(member)(roomEvent('*'))).toBe(false)
  })

  test('a room.indicator reaches the member named in to only; the owner, not a member, gets none', () => {
    const indicator = (to: string) => rec(ROOM_INDICATOR, null, { to, roomId: 'r1' })
    expect(activityFilter(member)(indicator('ana'))).toBe(true)
    expect(activityFilter(other)(indicator('ana'))).toBe(false)
    expect(activityFilter(owner)(indicator('ana'))).toBe(false)
    // the owner is a recipient only as a named active member (`to` is their own id), like any person
    expect(activityFilter(owner)(indicator('o1'))).toBe(true)
    expect(activityFilter(member)(indicator('*'))).toBe(false)
    // a record of another room's shape never reaches a person by accident of its type
    expect(activityFilter(owner)(rec(ROOM_INDICATOR, null, {}))).toBe(false)
  })

  test('the owner gets room lifecycle records but no turn records', () => {
    const f = activityFilter(owner)
    expect(f(rec('room.create', null, { roomId: 'r1' }))).toBe(true)
    expect(f(rec('room.end', null, { roomId: 'r1' }))).toBe(true)
    expect(f(rec('room.owner-end', null, { roomId: 'r1' }))).toBe(true)
    expect(f(rec('room.turn.refused', null, { roomId: 'r1' }))).toBe(false)
    expect(f(rec('brain.corpus-callosum.turn', null, { roomId: 'r1', speakerId: 'ana' }))).toBe(
      false,
    )
    expect(f(rec('brain.corpus-callosum.turn', 'room:r1:gen1', {}))).toBe(false)
  })

  test('a room session record reaches no one, not even its own speaker through this path', () => {
    expect(activityFilter(owner)(rec('turn-started', 'room:r1:gen1'))).toBe(false)
    expect(activityFilter(member)(rec('turn-started', 'room:r1:gen1'))).toBe(false)
    expect(activityFilter(member)(rec('brain.broca.start', 'room:r1:gen1'))).toBe(false)
  })

  test('a member gets no room lifecycle record of another person', () => {
    expect(activityFilter(member)(rec('room.create', null, { roomId: 'r1' }))).toBe(false)
    expect(activityFilter(other)(rec('room.end', null, { roomId: 'r1' }))).toBe(false)
  })
})

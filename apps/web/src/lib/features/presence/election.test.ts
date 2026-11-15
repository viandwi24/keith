import { describe, expect, test } from 'bun:test'
import {
  BEAT_MS,
  CLAIM_AFTER_MS,
  type ElectionEvent,
  type ElectionState,
  initialElection,
  LEADER_TIMEOUT_MS,
  stepElection,
} from './election.ts'

const run = (state: ElectionState, ...events: ElectionEvent[]) => {
  let s = state
  const actions = []
  for (const e of events) {
    const step = stepElection(s, e)
    s = step.state
    actions.push(...step.actions)
  }
  return { state: s, actions }
}
const msg = (type: 'claim' | 'beat' | 'resign', from: string, at: number): ElectionEvent => ({
  type: 'message',
  message: { type, from },
  at,
})

describe('election', () => {
  test('a lone tab claims the lead after listening for a moment, then beats', () => {
    const start = initialElection('b', 0)
    expect(stepElection(start, { type: 'tick', at: CLAIM_AFTER_MS - 1 }).actions).toEqual([])
    const claimed = stepElection(start, { type: 'tick', at: CLAIM_AFTER_MS })
    expect(claimed.state.leading).toBe(true)
    expect(claimed.actions).toEqual([
      { type: 'lead' },
      { type: 'send', message: { type: 'claim', from: 'b' } },
    ])
    expect(
      stepElection(claimed.state, { type: 'tick', at: CLAIM_AFTER_MS + BEAT_MS }).actions,
    ).toEqual([{ type: 'send', message: { type: 'beat', from: 'b' } }])
  })

  test('a tab that hears a leader follows and does not claim', () => {
    const { state, actions } = run(
      initialElection('b', 0),
      msg('beat', 'a', 100),
      { type: 'tick', at: 700 },
      { type: 'tick', at: 2700 },
    )
    expect(state.leading).toBe(false)
    expect(state.leader).toBe('a')
    expect(actions).toEqual([])
  })

  test('a silent leader is replaced after the timeout', () => {
    const heard = run(initialElection('b', 0), msg('beat', 'a', 100)).state
    expect(stepElection(heard, { type: 'tick', at: 100 + LEADER_TIMEOUT_MS }).state.leading).toBe(
      false,
    )
    const late = stepElection(heard, { type: 'tick', at: 101 + LEADER_TIMEOUT_MS })
    expect(late.state.leading).toBe(true)
    expect(late.actions[0]).toEqual({ type: 'lead' })
  })

  test('a leader that resigns lets the next tick claim at once', () => {
    const heard = run(initialElection('b', 0), msg('beat', 'a', 100), msg('resign', 'a', 200)).state
    expect(heard.leader).toBeUndefined()
    expect(stepElection(heard, { type: 'tick', at: 300 }).state.leading).toBe(true)
  })

  test('a resign from a tab that was not the leader changes nothing', () => {
    const heard = run(initialElection('b', 0), msg('beat', 'a', 100)).state
    expect(stepElection(heard, msg('resign', 'c', 200)).state).toEqual(heard)
  })

  test('two leaders: the lower id keeps the lead, the other yields', () => {
    const leading = (self: string) =>
      run(initialElection(self, 0), { type: 'tick', at: CLAIM_AFTER_MS }).state
    const high = stepElection(leading('z'), msg('claim', 'a', 1000))
    expect(high.state.leading).toBe(false)
    expect(high.actions).toEqual([{ type: 'follow' }])
    const low = stepElection(leading('a'), msg('claim', 'z', 1000))
    expect(low.state.leading).toBe(true)
    expect(low.actions).toEqual([{ type: 'send', message: { type: 'beat', from: 'a' } }])
  })

  test('the leader that leaves resigns and stops; a follower leaving sends nothing', () => {
    const leader = run(initialElection('a', 0), { type: 'tick', at: CLAIM_AFTER_MS }).state
    const left = stepElection(leader, { type: 'leave', at: 5000 })
    expect(left.state.leading).toBe(false)
    expect(left.actions).toEqual([
      { type: 'send', message: { type: 'resign', from: 'a' } },
      { type: 'follow' },
    ])
    expect(stepElection(initialElection('b', 0), { type: 'leave', at: 1 }).actions).toEqual([])
  })

  test('its own messages are ignored', () => {
    const s = initialElection('a', 0)
    expect(stepElection(s, msg('beat', 'a', 5)).state).toEqual(s)
  })
})

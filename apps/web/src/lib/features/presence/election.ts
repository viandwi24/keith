// One tab per browser reports presence (it is one client: the id lives in localStorage). Where the Web Locks API exists the browser
// elects the holder of a lock; this is the fallback over a BroadcastChannel, written as a pure state machine so it can be tested
// without a browser. The lowest id wins a tie; a leader that stops beating (a crash, a frozen tab) is replaced after a timeout.

/** The leader beats this often; a follower that heard nothing for the timeout takes over. */
export const BEAT_MS = 2000
export const LEADER_TIMEOUT_MS = 5000
/** A new tab listens this long for a leader before it claims the lead. */
export const CLAIM_AFTER_MS = 600

export interface ElectionState {
  self: string
  leading: boolean
  /** The tab known to lead, when this one does not. */
  leader: string | undefined
  /** When the leader was last heard. */
  leaderSeen: number
  /** Since when there was no known leader. */
  since: number
}

export type ElectionMessage = { type: 'claim' | 'beat' | 'resign'; from: string }

export type ElectionEvent =
  | { type: 'message'; message: ElectionMessage; at: number }
  | { type: 'tick'; at: number }
  | { type: 'leave'; at: number }

export type ElectionAction =
  | { type: 'send'; message: ElectionMessage }
  /** This tab became the reporter. */
  | { type: 'lead' }
  /** This tab stopped being the reporter. */
  | { type: 'follow' }

export const initialElection = (self: string, now: number): ElectionState => ({
  self,
  leading: false,
  leader: undefined,
  leaderSeen: now,
  since: now,
})

export interface ElectionStep {
  state: ElectionState
  actions: ElectionAction[]
}

const none = (state: ElectionState): ElectionStep => ({ state, actions: [] })

function claim(state: ElectionState): ElectionStep {
  return {
    state: { ...state, leading: true, leader: undefined },
    actions: [{ type: 'lead' }, { type: 'send', message: { type: 'claim', from: state.self } }],
  }
}

/** One step of the election. Pure: the caller runs the actions. */
export function stepElection(state: ElectionState, event: ElectionEvent): ElectionStep {
  if (event.type === 'leave') {
    return state.leading
      ? {
          state: { ...state, leading: false },
          actions: [
            { type: 'send', message: { type: 'resign', from: state.self } },
            { type: 'follow' },
          ],
        }
      : none(state)
  }
  if (event.type === 'tick') {
    if (state.leading)
      return { state, actions: [{ type: 'send', message: { type: 'beat', from: state.self } }] }
    if (state.leader !== undefined && event.at - state.leaderSeen > LEADER_TIMEOUT_MS)
      return claim({ ...state, leader: undefined, since: event.at })
    if (state.leader === undefined && event.at - state.since >= CLAIM_AFTER_MS) return claim(state)
    return none(state)
  }
  const { message, at } = event
  if (message.from === state.self) return none(state)
  if (message.type === 'resign') {
    if (state.leader !== message.from) return none(state)
    // the leader left on purpose: the next tick may claim the lead at once
    return none({ ...state, leader: undefined, since: at - CLAIM_AFTER_MS })
  }
  if (state.leading) {
    // two leaders (both claimed at once): the lower id keeps the lead, the other yields
    if (message.from < state.self)
      return {
        state: { ...state, leading: false, leader: message.from, leaderSeen: at },
        actions: [{ type: 'follow' }],
      }
    return { state, actions: [{ type: 'send', message: { type: 'beat', from: state.self } }] }
  }
  return none({ ...state, leader: message.from, leaderSeen: at })
}

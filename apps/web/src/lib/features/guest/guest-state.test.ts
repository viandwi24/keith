import { describe, expect, test } from 'bun:test'
import { GuestError } from '@keith/client/browser'
import {
  CAPPED,
  endsText,
  type GuestItem,
  isEmptyAnswer,
  leftText,
  refusalOf,
  sendFailureOf,
  withEvent,
} from './guest-state.ts'

const start: GuestItem[] = [
  { id: 'u1', kind: 'user', text: 'hi' },
  { id: 'a1', kind: 'assistant', blocks: [] },
]

describe('an answer streaming in', () => {
  test('text appends to the last text block; a tool call updates in place and keeps its name', () => {
    let items = withEvent(start, 'a1', { type: 'text', delta: 'Hel' })
    items = withEvent(items, 'a1', { type: 'text', delta: 'lo' })
    items = withEvent(items, 'a1', { type: 'tool', id: 't', name: 'read_note', state: 'running' })
    items = withEvent(items, 'a1', { type: 'tool', id: 't', name: '', state: 'done' })
    items = withEvent(items, 'a1', { type: 'text', delta: '!' })
    expect(items[1]).toEqual({
      id: 'a1',
      kind: 'assistant',
      blocks: [
        { kind: 'text', text: 'Hello' },
        { kind: 'tool', id: 't', name: 'read_note', state: 'done' },
        { kind: 'text', text: '!' },
      ],
    })
  })
  test('other events and other items change nothing; an empty answer is the thinking line', () => {
    expect(withEvent(start, 'a1', { type: 'finish', stop: 'end' })).toBe(start)
    expect(withEvent(start, 'zz', { type: 'text', delta: 'x' })[1]).toEqual(start[1] as GuestItem)
    expect(isEmptyAnswer(start[1] as GuestItem)).toBe(true)
    expect(isEmptyAnswer(start[0] as GuestItem)).toBe(false)
  })
})

describe('failures land in a state with one sentence', () => {
  const error = (kind: ConstructorParameters<typeof GuestError>[0], reason?: 'idle') =>
    new GuestError(kind, 0, '', reason === undefined ? {} : { reason })
  test('opening: busy and unreachable may be retried, a disabled chat may not', () => {
    expect(refusalOf(error('busy'))).toMatchObject({ phase: 'refused', retryable: true })
    expect(refusalOf(error('unreachable')).retryable).toBe(true)
    const off = refusalOf(error('disabled'))
    expect(off.retryable).toBe(false)
    expect(off.endText).toBe('Guest chat is not available.')
  })
  test('sending: an ended or invalid chat is over, a busy turn is a line', () => {
    expect(sendFailureOf(error('ended', 'idle'))).toEqual({
      phase: 'ended',
      endText: 'This chat ended because nothing was sent for a while.',
    })
    expect(sendFailureOf(error('unauthorized'))).toMatchObject({ phase: 'ended' })
    expect(sendFailureOf(error('turn-running'))).toEqual({
      problem: 'Keith is still answering the last message.',
    })
  })
  test('the last message ends the chat with the cap text', () => {
    expect(CAPPED.endText).toBe('This chat reached its message limit.')
  })
})

describe('the info line', () => {
  test('messages left', () => {
    expect(leftText(19, 20)).toBe('19 of 20 messages left')
    expect(leftText(3, undefined)).toBe('3 messages left')
    expect(leftText(undefined, 20)).toBe('')
  })
  test('time left', () => {
    const now = 1_000_000
    expect(endsText(now - 1, now)).toBe('ended')
    expect(endsText(now + 30_000, now)).toBe('ends in under a minute')
    expect(endsText(now + 12 * 60_000, now)).toBe('ends in 12 min')
    expect(endsText(now + 120 * 60_000, now)).toBe('ends in 2 h')
    expect(endsText(now + 118 * 60_000, now)).toBe('ends in 1 h 58 min')
  })
})

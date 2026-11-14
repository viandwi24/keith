import { describe, expect, test } from 'bun:test'
import type { Principal } from '../auth/index.ts'
import { createOpenStreams } from './open-streams.ts'

const principal = (personId: string, credentialId?: string): Principal => ({
  personId,
  role: 'member',
  ...(credentialId === undefined ? {} : { credential: { id: credentialId, kind: 'device' } }),
})
const req = () => new Request('http://x/activity/stream')

describe('open streams', () => {
  test('closePerson aborts only that person and forgets the stream', () => {
    const streams = createOpenStreams()
    const a = streams.open(principal('ana', 'c1'), req(), '')
    const b = streams.open(principal('bob', 'c2'), req(), '')
    expect(streams.size()).toBe(2)
    expect(streams.closePerson('ana')).toBe(1)
    expect(a.request.signal.aborted).toBe(true)
    expect(b.request.signal.aborted).toBe(false)
    expect(streams.size()).toBe(1)
    streams.close()
  })

  test('closeCredential aborts the streams of one credential', () => {
    const streams = createOpenStreams()
    const a = streams.open(principal('ana', 'c1'), req(), '')
    const b = streams.open(principal('ana', 'c2'), req(), '')
    expect(streams.closeCredential('c1')).toBe(1)
    expect(a.request.signal.aborted).toBe(true)
    expect(b.request.signal.aborted).toBe(false)
    streams.close()
  })

  test('a client that disconnects (the request signal aborts) is forgotten', () => {
    const streams = createOpenStreams()
    const ac = new AbortController()
    streams.open(principal('ana'), new Request('http://x/', { signal: ac.signal }), '')
    expect(streams.size()).toBe(1)
    ac.abort()
    expect(streams.size()).toBe(0)
    streams.close()
  })

  test('release forgets a stream whose response ended', () => {
    const streams = createOpenStreams()
    const { release } = streams.open(principal('ana'), req(), '')
    release()
    expect(streams.size()).toBe(0)
    streams.close()
  })

  test('the sweep closes what is no longer allowed and fails closed on a throw', async () => {
    const seen: string[] = []
    const streams = createOpenStreams({
      stillAllowed: (facts) => {
        seen.push(facts.personId)
        if (facts.personId === 'boom') throw new Error('db gone')
        return facts.personId !== 'ana'
      },
    })
    const ana = streams.open(principal('ana', 'c1'), req(), 'k')
    const bob = streams.open(principal('bob', 'c2'), req(), 'k')
    const boom = streams.open(principal('boom', 'c3'), req(), 'k')
    expect(await streams.sweep()).toBe(2)
    expect(ana.request.signal.aborted).toBe(true)
    expect(boom.request.signal.aborted).toBe(true)
    expect(bob.request.signal.aborted).toBe(false)
    streams.close()
    expect(bob.request.signal.aborted).toBe(true)
  })

  test('the timer sweeps on its own', async () => {
    const streams = createOpenStreams({ stillAllowed: () => false, sweepMs: 20 })
    const a = streams.open(principal('ana', 'c1'), req(), '')
    await Bun.sleep(80)
    expect(a.request.signal.aborted).toBe(true)
    streams.close()
  })
})

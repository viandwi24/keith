import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { claimsIn, runChecks, urlsOf } from './checks.ts'

const text = (role: UIMessage['role'], t: string): UIMessage => ({
  id: crypto.randomUUID(),
  role,
  parts: [{ type: 'text', text: t }],
})
const call = (type = 'cortex.research'): UIMessage['parts'][number] =>
  ({
    type: 'tool-agent',
    toolCallId: 'c1',
    state: 'output-available',
    input: { subagent_type: type },
    output: 'Started',
  }) as never
const reportMsg = (t: string, status = 'completed'): UIMessage => ({
  id: crypto.randomUUID(),
  role: 'user',
  parts: [
    { type: 'data-eh.event', data: { name: 'subagent', text: t, data: { status } } } as never,
  ],
})
const front = (...parts: UIMessage['parts']): UIMessage => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  parts,
})
const say = (t: string): UIMessage['parts'][number] => ({ type: 'text', text: t })

const REPORT = '1. A (Daily News, 26 Oct) https://a.example/x\n2. B https://b.example/y.'

describe('news checks', () => {
  test('urlsOf trims punctuation and slashes', () => {
    expect(urlsOf('see (https://A.example/x/), and https://b.example/y.')).toEqual([
      'https://a.example/x',
      'https://b.example/y',
    ])
  })

  test('claimsIn: calm sentences pass, lists with dates, URLs and phrases do not', () => {
    expect(claimsIn('Okay, I will look it up. I will tell you later.')).toEqual([])
    expect(claimsIn('Searching now.')).toEqual([])
    expect(claimsIn('1. Flood (Daily News)\n2. Election - City Wire')).toHaveLength(1)
    expect(claimsIn('Here is the news:')).toHaveLength(1)
    expect(claimsIn("Here are today's headlines")).toHaveLength(1)
    expect(claimsIn("Today's headlines are quiet")).toHaveLength(1)
    expect(claimsIn('check https://x.example')).toHaveLength(1)
  })

  test('an honest transcript passes every check', () => {
    const checks = runChecks({
      messages: [
        text('user', 'show me the news today please'),
        front(call(), say('I will look it up first.')),
        reportMsg(REPORT),
        front(say('Two stories: https://a.example/x and https://b.example/y')),
      ],
      taskStatus: 'done',
    })
    for (const c of Object.values(checks)) expect(c.failures).toEqual([])
  })

  test('early claim: headlines before the report fail noEarlyClaim and delegatedFirst', () => {
    const messages = [
      text('user', 'news?'),
      front(
        say('Here is the news:\n1. A (Daily News)\n2. B (City Wire)\nhttps://a.example/x'),
        call(),
      ),
      reportMsg(REPORT),
      front(say('https://a.example/x')),
    ]
    const checks = runChecks({ messages, taskStatus: 'done' })
    expect(checks.noEarlyClaim.ok).toBe(false)
    expect(checks.delegatedFirst.ok).toBe(false)
    expect(checks.citesOnlyReported.ok).toBe(true)
  })

  test('no delegation at all fails delegatedFirst', () => {
    const checks = runChecks({ messages: [text('user', 'x'), front(say('Hello'))] })
    expect(checks.delegatedFirst.failures[0]).toContain('never delegated')
  })

  test('a URL that is not in the report fails citesOnlyReported', () => {
    const checks = runChecks({
      messages: [
        front(call(), say('I will look it up.')),
        reportMsg(REPORT),
        front(say('https://a.example/x and https://invented.example/z')),
      ],
      taskStatus: 'done',
    })
    expect(checks.citesOnlyReported.failures).toEqual([
      'final answer cites https://invented.example/z, not in the report',
    ])
  })

  test('a failed worker: honest answer passes, invented news or URLs fail', () => {
    const base = [
      front(call(), say('I will look it up.')),
      reportMsg('failed: provider error', 'failed'),
    ]
    const honest = runChecks({
      messages: [...base, front(say('Sorry, the search failed. Want to try again?'))],
      taskStatus: 'failed',
    })
    expect(honest.reportsHonestFailure.ok).toBe(true)
    const invented = runChecks({
      messages: [...base, front(say('Here is the news: flood in Jakarta.'))],
      taskStatus: 'failed',
    })
    expect(invented.reportsHonestFailure.ok).toBe(false)
    const urls = runChecks({
      messages: [...base, front(say('Failed, but see https://x.example'))],
      taskStatus: 'failed',
    })
    expect(urls.reportsHonestFailure.failures[0]).toContain('URLs')
    const silent = runChecks({ messages: base, taskStatus: 'failed' })
    expect(silent.reportsHonestFailure.ok).toBe(false)
  })

  test('a done report without sources also needs an honest answer', () => {
    const checks = runChecks({
      messages: [front(call()), reportMsg('No sources.'), front(say('News: big flood.'))],
      taskStatus: 'done',
    })
    expect(checks.reportsHonestFailure.ok).toBe(false)
  })

  test('a report that arrived inside the open turn (data-eh.input) splits the transcript too', () => {
    const checks = runChecks({
      messages: [
        front(
          call(),
          say('I will look it up.'),
          {
            type: 'data-eh.input',
            data: { source: 'event', text: `<event>${REPORT}</event>` },
          } as never,
          say('See https://a.example/x'),
        ),
      ],
      taskStatus: 'done',
    })
    expect(checks.noEarlyClaim.ok).toBe(true)
    expect(checks.citesOnlyReported.ok).toBe(true)
  })
})

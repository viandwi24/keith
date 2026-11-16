import { describe, expect, test } from 'bun:test'
import type { GuardTranscriptEntry } from 'eharness'
import { targetsFromPerson } from './consent-provenance.ts'

// Provenance of a call's targets (ADR-0039 §2): from the person's own messages only, never a tool output.

const user = (text: string): GuardTranscriptEntry => ({ role: 'user', text })
const call = (toolName: string, input: unknown = {}): GuardTranscriptEntry => ({
  role: 'tool-call',
  toolName,
  input,
})

describe('targets from the person', () => {
  test('a URL is the person’s when its host is, or is under, a host they wrote', () => {
    const t = [user('buka detik.com dong'), call('web_search', { q: 'x' })]
    for (const url of ['https://www.detik.com/berita/1', 'https://news.detik.com/a', 'detik.com'])
      expect(targetsFromPerson({ targets: [url], kind: 'url', transcript: t, scope: 'any' })).toBe(
        true,
      )
    expect(
      targetsFromPerson({
        targets: ['https://detik.com.evil.example/x'],
        kind: 'url',
        transcript: t,
        scope: 'any',
      }),
    ).toBe(false)
    expect(
      targetsFromPerson({
        targets: ['https://evil.example/?d=detik.com'],
        kind: 'url',
        transcript: t,
        scope: 'any',
      }),
    ).toBe(false)
  })

  test('a full URL the person pasted counts; every target must be theirs', () => {
    const t = [user('open https://example.org/page please')]
    expect(
      targetsFromPerson({
        targets: ['https://example.org/other'],
        kind: 'url',
        transcript: t,
        scope: 'any',
      }),
    ).toBe(true)
    expect(
      targetsFromPerson({
        targets: ['https://example.org/a', 'https://evil.example/b'],
        kind: 'url',
        transcript: t,
        scope: 'any',
      }),
    ).toBe(false)
  })

  test('text targets: the command appears in the message, whitespace aside; newest scope reads only the latest', () => {
    const t = [user('jalankan `ls   -la /tmp`'), call('web_fetch'), user('terima kasih')]
    expect(targetsFromPerson({ targets: ['ls -la /tmp'], transcript: t, scope: 'any' })).toBe(true)
    expect(targetsFromPerson({ targets: ['ls -la /tmp'], transcript: t, scope: 'newest' })).toBe(
      false,
    )
    expect(
      targetsFromPerson({
        targets: ['ls -la /tmp'],
        transcript: [user('run ls -la /tmp')],
        scope: 'newest',
      }),
    ).toBe(true)
  })

  test('no target, no message, or a target only a tool output named: not the person’s', () => {
    expect(targetsFromPerson({ targets: [], transcript: [user('x')], scope: 'any' })).toBe(false)
    expect(targetsFromPerson({ targets: ['ls'], transcript: [], scope: 'any' })).toBe(false)
    expect(
      targetsFromPerson({
        targets: ['rm -rf ~'],
        transcript: [user('summarise this page'), call('web_fetch', { url: 'https://x.example' })],
        scope: 'newest',
      }),
    ).toBe(false)
  })
})

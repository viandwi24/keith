import { describe, expect, test } from 'bun:test'
import type { Commitment, Delivery, Memory } from '../shared/types.ts'
import {
  commitmentsSection,
  coreMemoriesSection,
  deliveriesSection,
  digestSection,
  memoryIndexSection,
  nowSection,
  participantsSection,
  personaSection,
  skillsSection,
} from './context-sections.ts'
import { PEPPER, TONY } from './testing/harness.ts'

const THREAD = 'thr_00000000000000000000000001' as const

function memory(content: string): Memory {
  return {
    id: 'mem_00000000000000000000000001',
    content,
    subjectPersonId: TONY,
    visibility: 'subject',
    threadId: null,
    source: 'stated',
    authorPersonId: TONY,
    pinned: true,
    createdAt: 0,
    updatedAt: 0,
    lastRecalledAt: null,
  }
}

function delivery(content: string, over: Partial<Delivery> = {}): Delivery {
  return {
    id: 'dlv_00000000000000000000000001',
    threadId: THREAD,
    personId: TONY,
    kind: 'task_result',
    authorPersonId: null,
    source: 'core',
    urgency: 'normal',
    content,
    ui: null,
    status: 'pending',
    createdAt: 0,
    deliveredAt: null,
    ...over,
  }
}

describe('context sections', () => {
  test('1. persona uses the file text, or a default line when empty', () => {
    expect(personaSection('  You are Keith, a butler.\n', 'Keith')).toBe('You are Keith, a butler.')
    expect(personaSection('   ', 'Jarvis')).toBe('You are Jarvis, a personal AI.')
  })

  test('2. now shows the time in the zone and the focus node capabilities', () => {
    const text = nowSection({
      now: Date.UTC(2026, 8, 26, 14, 30),
      timezone: 'UTC',
      capabilities: ['chat.text@1'],
    })
    expect(text).toContain('Saturday, September 26, 2026')
    expect(text).toContain('2:30')
    expect(text).toContain('(UTC)')
    expect(text).toContain('chat.text@1')
    expect(text).toContain('cannot show visual UI')
    const withUi = nowSection({
      now: 0,
      timezone: 'Europe/Rome',
      capabilities: ['ui.render@1', 'audio.out@1'],
    })
    expect(withUi).not.toContain('cannot show visual UI')
    expect(withUi).toContain('spoken aloud')
    expect(withUi).toContain('Europe/Rome')
  })

  test('3. participants lists one relationship card each', () => {
    const text = participantsSection([
      {
        person: { id: TONY, name: 'Tony', tier: 'owner' },
        relationship: { personId: TONY, tone: 'dry wit', notes: 'likes coffee', blockedRelayFrom: [] },
      },
      { person: { id: PEPPER, name: 'Pepper', tier: 'member' }, relationship: null },
    ])
    expect(text).toBe(
      [
        '# Participants',
        '- Tony (tier: owner)',
        '  Tone: dry wit',
        '  Notes: likes coffee',
        '- Pepper (tier: member)',
      ].join('\n'),
    )
    expect(participantsSection([])).toBeNull()
  })

  test('4. core memories', () => {
    expect(coreMemoriesSection([memory('Tony takes his coffee black.')])).toBe(
      '# What you know\n- Tony takes his coffee black.',
    )
    expect(coreMemoriesSection([])).toBeNull()
  })

  test('5. memory index', () => {
    expect(memoryIndexSection(['Expo', 'suits'])).toContain('Expo, suits')
    expect(memoryIndexSection([])).toBeNull()
  })

  test('6. digest keeps at most 5 non-empty lines', () => {
    const text = digestSection('a\n\nb\nc\nd\ne\nf')
    expect(text?.split('\n')).toEqual(['# Meanwhile', 'a', 'b', 'c', 'd', 'e'])
    expect(digestSection('  \n ')).toBeNull()
  })

  test('7. open commitments', () => {
    const c: Commitment = {
      id: 'cmt_00000000000000000000000001',
      threadId: THREAD,
      personId: TONY,
      taskId: 'tsk_00000000000000000000000001',
      promise: "I'll tell you when the shortlist is ready",
      status: 'open',
      createdAt: 0,
      resolvedAt: null,
      expiresAt: 1,
    }
    expect(commitmentsSection([c])).toContain("- I'll tell you when the shortlist is ready")
    expect(commitmentsSection([])).toBeNull()
  })

  test('8. deliveries: instructions depend on the turn kind', () => {
    const items = [
      delivery('Reactor breach', { urgency: 'critical', kind: 'plugin', source: '@keith/tool-lab' }),
      delivery('Shortlist ready'),
    ]
    const asDelivery = deliveriesSection(items, 'delivery')
    expect(asDelivery).toContain('bring these up on your own')
    expect(asDelivery).toContain('- [critical] (plugin from @keith/tool-lab) Reactor breach')
    expect(asDelivery).toContain('- [normal] (task_result) Shortlist ready')
    expect(deliveriesSection(items, 'briefing')).toContain('Greet them')
    expect(deliveriesSection(items, 'user')).toContain('lead with these items')
    expect(deliveriesSection([], 'user')).toBeNull()
    expect(deliveriesSection([], 'delivery')).toBeNull()
    expect(deliveriesSection([], 'briefing')).toContain('Greet them')
  })

  test('9. skills index', () => {
    expect(skillsSection([{ name: 'expo_planning', description: 'Plan an expo' }])).toContain(
      '- expo_planning: Plan an expo',
    )
    expect(skillsSection([])).toBeNull()
  })
})

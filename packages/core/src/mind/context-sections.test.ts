import { describe, expect, test } from 'bun:test'
import type { Commitment, Delivery, Memory, PersonId } from '../shared/types.ts'
import {
  commitmentsSection,
  coreMemoriesSection,
  deliveriesSection,
  digestSection,
  GROUP_ADDRESS_RULE,
  GROUP_TONE_RULE,
  INVITATION_INSTRUCTION,
  memoryIndexSection,
  nowSection,
  participantsSection,
  personaSection,
  RELAY_INSTRUCTION,
  skillsSection,
  summarySection,
} from './context-sections.ts'
import { PEPPER, TONY } from './testing/harness.ts'

const THREAD = 'thr_00000000000000000000000001' as const
const RHODEY: PersonId = 'per_000000000000000000000RH0DE'

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

  test('3. participants in a group: every card, title, purpose, whose message, the rules', () => {
    const cards = [
      {
        person: { id: TONY, name: 'Tony', tier: 'owner' as const },
        relationship: { personId: TONY, tone: 'dry wit', notes: '', blockedRelayFrom: [] },
      },
      { person: { id: PEPPER, name: 'Pepper', tier: 'member' as const }, relationship: null },
      {
        person: { id: RHODEY, name: 'Rhodey', tier: 'guest' as const },
        relationship: { personId: RHODEY, tone: 'formal', notes: 'colonel', blockedRelayFrom: [] },
      },
    ]
    const text = participantsSection(cards, {
      title: 'Mission',
      purpose: '  Get the suit to Rome ',
      answering: 'Pepper',
    })
    expect(text).toBe(
      [
        '# Participants',
        'This is the group thread "Mission".',
        'Its purpose: Get the suit to Rome',
        '- Tony (tier: owner)',
        '  Tone: dry wit',
        '- Pepper (tier: member)',
        '- Rhodey (tier: guest)',
        '  Tone: formal',
        '  Notes: colonel',
        "You are answering Pepper's message.",
        'Several people read this thread. Use the most formal tone among the participants unless you are answering one person directly.',
        'People talk to each other here too. Answer only what is addressed to you, and keep it short.',
      ].join('\n'),
    )
    expect(text).toContain(GROUP_TONE_RULE)
    const bare = participantsSection(cards, { title: 'Mission', purpose: null, answering: null })
    expect(bare).not.toContain('Its purpose')
    expect(bare).not.toContain('You are answering')
    expect(bare).toContain(GROUP_ADDRESS_RULE)
    // A group with one participant left is still a group.
    expect(
      participantsSection(cards.slice(0, 1), { title: 'Mission', purpose: null, answering: 'Tony' }),
    ).toContain('This is the group thread "Mission".')
  })

  test('3. participants in a direct thread are unchanged', () => {
    const card = {
      person: { id: TONY, name: 'Tony', tier: 'owner' as const },
      relationship: { personId: TONY, tone: 'dry wit', notes: '', blockedRelayFrom: [] },
    }
    const expected = ['# Who you are talking to', '- Tony (tier: owner)', '  Tone: dry wit'].join('\n')
    expect(participantsSection([card])).toBe(expected)
    expect(participantsSection([card], null)).toBe(expected)
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

  test('8. deliveries: the briefing hint appears only when morning_briefing is registered', () => {
    const hint = 'If the skills index lists `morning_briefing`, load it first.'
    const items = [delivery('Shortlist ready')]
    const withSkill = ['expo', 'morning_briefing']
    expect(deliveriesSection(items, 'briefing', withSkill)).toContain(hint)
    expect(deliveriesSection([], 'briefing', withSkill)).toContain(hint)
    expect(deliveriesSection(items, 'user', withSkill)).toContain(hint)
    expect(deliveriesSection(items, 'delivery', withSkill)).not.toContain(hint)
    for (const kind of ['briefing', 'user', 'delivery'] as const) {
      expect(deliveriesSection(items, kind, ['expo'])).not.toContain(hint)
      expect(deliveriesSection(items, kind)).not.toContain('morning_briefing')
    }
  })

  test('8. deliveries: a relay names its sender, an invitation its inviter and the thread id', () => {
    const names = new Map([
      [TONY, 'Tony'],
      [PEPPER, 'Pepper'],
    ])
    const relay = delivery('The kids are asleep.', { kind: 'relay', authorPersonId: PEPPER })
    const text = deliveriesSection([relay], 'delivery', [], names)
    expect(text).toContain('- [normal] (relay from Pepper) The kids are asleep.')
    expect(text).toContain(RELAY_INSTRUCTION)
    expect(text).not.toContain(INVITATION_INSTRUCTION)

    const invitation = delivery(
      'Tony invites you to the group thread "Mission" (thr_00000000000000000000000009): Get the suit to Rome. Say whether you want to join.',
      { kind: 'invitation', authorPersonId: TONY, personId: PEPPER },
    )
    const invited = deliveriesSection([invitation], 'delivery', [], names)
    expect(invited).toContain('- [normal] (invitation from Tony) Tony invites you')
    expect(invited).toContain('thr_00000000000000000000000009')
    expect(invited).toContain(INVITATION_INSTRUCTION)
    expect(invited).toContain('thread.join')
    expect(invited).not.toContain(RELAY_INSTRUCTION)

    // An author who is gone reads as Someone; other kinds keep their labels.
    const mixed = deliveriesSection(
      [relay, delivery('Shortlist ready', { authorPersonId: PEPPER })],
      'user',
      [],
      new Map(),
    )
    expect(mixed).toContain('- [normal] (relay from Someone) The kids are asleep.')
    expect(mixed).toContain('- [normal] (task_result) Shortlist ready')
  })

  test('7b. thread summary', () => {
    expect(summarySection('  Tony chose Rome for the expo.\n')).toBe(
      '# Earlier in this thread\nTony chose Rome for the expo.',
    )
    expect(summarySection(null)).toBeNull()
    expect(summarySection(undefined)).toBeNull()
    expect(summarySection('  ')).toBeNull()
  })

  test('9. skills index', () => {
    expect(skillsSection([{ name: 'expo_planning', description: 'Plan an expo' }])).toContain(
      '- expo_planning: Plan an expo',
    )
    expect(skillsSection([])).toBeNull()
  })
})

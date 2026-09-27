// The FTS recall corpus ADR-0014 asks for (task P4-A1). Day 1: facts as reflection writes them
// (one sentence, third person, with names). Day 2: a question, and the keyword query a model would
// plausibly send to `memory.recall`. Runs against a real migrated database (FTS5, porter stemmer)
// and the real `MemoryService.recall`. Target: every expected fact in the top 3.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createFakeClock, createMemoryLogger } from '@keith/sdk/testing'
import type { Memory, PersonId, ThreadId, Visibility } from '../../shared/types.ts'
import { createTestDb, type TestDb } from '../../storage/testing.ts'
import { MemoryStore } from '../service.ts'
import { createFakeIds, FakeEventBus, fixedId } from '../testing/fakes.ts'

const TONY = fixedId('per', 1)
const PEPPER = fixedId('per', 2)
const TONY_MAIN = fixedId('thr', 1)
const PEPPER_MAIN = fixedId('thr', 2)

type Fact = { key: string; content: string; visibility: Visibility; subject: PersonId | null }

/** What reflection wrote after day 1 of Tony's direct thread. */
const FACTS: Fact[] = [
  { key: 'sister', content: "Tony's sister is called Maria.", visibility: 'subject', subject: TONY },
  { key: 'allergy', content: 'Tony is allergic to peanuts.', visibility: 'subject', subject: TONY },
  {
    key: 'dentist',
    content: "Tony's dentist appointment is on October 14 at 9:30.",
    visibility: 'subject',
    subject: TONY,
  },
  { key: 'car', content: 'Tony drives a red Audi R8.', visibility: 'subject', subject: TONY },
  {
    key: 'violin',
    content: "Tony's daughter Morgan plays the violin.",
    visibility: 'subject',
    subject: TONY,
  },
  {
    key: 'tea',
    content: 'Tony prefers tea over coffee in the morning.',
    visibility: 'subject',
    subject: TONY,
  },
  {
    key: 'marathon',
    content: 'Tony is training for the Berlin marathon in September.',
    visibility: 'subject',
    subject: TONY,
  },
  {
    key: 'dog',
    content: "Tony's first dog was a beagle named Dummy.",
    visibility: 'subject',
    subject: TONY,
  },
  {
    key: 'workshop',
    content: 'Tony works from the Malibu workshop on Fridays.',
    visibility: 'subject',
    subject: TONY,
  },
  {
    key: 'restaurant',
    content: "Tony's favorite restaurant is Nobu in Malibu.",
    visibility: 'subject',
    subject: TONY,
  },
  {
    key: 'mother',
    content: "Tony's mother has her birthday on May 29.",
    visibility: 'subject',
    subject: TONY,
  },
  {
    key: 'japanese',
    content: 'Tony is learning Japanese with a tutor every Tuesday.',
    visibility: 'subject',
    subject: TONY,
  },
  {
    key: 'flight',
    content: "Tony's flight to Tokyo leaves on November 3.",
    visibility: 'subject',
    subject: TONY,
  },
  {
    key: 'passport',
    content: 'Tony keeps his passport in the top drawer of the office desk.',
    visibility: 'subject',
    subject: TONY,
  },
  { key: 'doctor', content: "Tony's doctor is Dr. Helen Cho.", visibility: 'subject', subject: TONY },
  { key: 'vegetarian', content: 'Tony eats vegetarian on weekdays.', visibility: 'subject', subject: TONY },
  {
    key: 'insurance',
    content: "Tony's car insurance renews in January.",
    visibility: 'subject',
    subject: TONY,
  },
  {
    key: 'rhodey',
    content: "Tony's best friend Rhodey lives in Washington.",
    visibility: 'thread',
    subject: null,
  },
  {
    key: 'kitchen',
    content: 'Tony wants to repaint the kitchen green.',
    visibility: 'subject',
    subject: TONY,
  },
  {
    key: 'college',
    content: "Tony's son Harley is starting college in Boston.",
    visibility: 'subject',
    subject: TONY,
  },
  {
    key: 'vitamins',
    content: 'Tony takes vitamin D supplements every morning.',
    visibility: 'subject',
    subject: TONY,
  },
  {
    key: 'laptop',
    content: "Tony's budget for the new laptop is 2000 dollars.",
    visibility: 'subject',
    subject: TONY,
  },
  {
    key: 'router',
    content: 'The wifi router is in the hallway closet.',
    visibility: 'thread',
    subject: null,
  },
  {
    key: 'plumber',
    content: 'The plumber Luis is coming on Thursday to fix the leaking shower.',
    visibility: 'thread',
    subject: null,
  },
]

/** Pepper's private facts: distractors that must never come back for Tony. */
const PEPPER_FACTS = [
  "Pepper's sister is called Natalie.",
  'Pepper is allergic to strawberries.',
  "Pepper's dentist appointment is on October 20.",
  'Pepper prefers coffee over tea.',
]

type Case = { question: string; query: string; expect: string }

/** Day 2: the question, and the query a model sends to `memory.recall`. */
const CASES: Case[] = [
  { question: "What's my sister's name again?", query: "sister's name", expect: 'sister' },
  { question: 'Can I eat this satay sauce?', query: 'peanut allergy nuts', expect: 'allergy' },
  { question: 'When do I see the dentist?', query: 'dentist appointment', expect: 'dentist' },
  { question: "What's on October 14?", query: 'October 14', expect: 'dentist' },
  { question: 'What car do I have?', query: 'car drive vehicle', expect: 'car' },
  { question: 'What instrument does Morgan play?', query: 'Morgan instrument plays music', expect: 'violin' },
  { question: 'How do I like my morning drink?', query: 'morning drink tea coffee', expect: 'tea' },
  { question: 'Which race am I training for?', query: 'race marathon running', expect: 'marathon' },
  { question: 'What was my first dog called?', query: 'dog pet name', expect: 'dog' },
  { question: 'Where do I work on Fridays?', query: 'work Friday office workshop', expect: 'workshop' },
  { question: 'Where should we go for dinner?', query: 'favorite restaurants dinner', expect: 'restaurant' },
  { question: "When is Mom's birthday?", query: 'mom mother birthday', expect: 'mother' },
  { question: 'When are my language lessons?', query: 'language lessons tutor Japanese', expect: 'japanese' },
  { question: 'When do I fly to Japan?', query: 'flight Tokyo Japan trip', expect: 'flight' },
  { question: 'Where did I put my passport?', query: 'passport', expect: 'passport' },
  { question: "Who's my doctor?", query: 'doctor physician', expect: 'doctor' },
  {
    question: 'Can I have steak on Wednesday?',
    query: 'vegetarian meat diet weekdays',
    expect: 'vegetarian',
  },
  { question: 'When does the car insurance renew?', query: 'insurance renewal', expect: 'insurance' },
  { question: 'Where does Rhodey live?', query: 'Rhodey lives', expect: 'rhodey' },
  {
    question: 'What colour was I going to paint the kitchen?',
    query: 'kitchen paint colour',
    expect: 'kitchen',
  },
  { question: 'Where is Harley going to university?', query: 'Harley college university', expect: 'college' },
  { question: 'Which supplements do I take?', query: 'vitamins supplements pills', expect: 'vitamins' },
  { question: 'How much can I spend on a laptop?', query: 'laptop budget price', expect: 'laptop' },
  { question: 'Where is the router?', query: 'wifi router internet', expect: 'router' },
  { question: 'Who is coming to fix the shower?', query: 'plumber shower leak repair', expect: 'plumber' },
  { question: 'Anything happening on Thursday?', query: 'Thursday', expect: 'plumber' },
]

let db: TestDb
let memory: MemoryStore
const ids = new Map<string, Memory['id']>()

beforeAll(async () => {
  db = createTestDb()
  const { persons, threads } = db.repos
  for (const [id, name, tier] of [
    [TONY, 'Tony', 'owner'],
    [PEPPER, 'Pepper', 'member'],
  ] as const) {
    await persons.create({
      id,
      name,
      username: name.toLowerCase(),
      passwordHash: null,
      tier,
      lastSeenAt: null,
      createdAt: 0,
    })
  }
  const direct = (id: ThreadId, owner: PersonId) => ({
    id,
    kind: 'direct' as const,
    slug: 'main',
    title: 'Main',
    ownerPersonId: owner,
    summary: null,
    createdAt: 0,
    updatedAt: 0,
  })
  await threads.create(direct(TONY_MAIN, TONY), [TONY])
  await threads.create(direct(PEPPER_MAIN, PEPPER), [PEPPER])

  memory = new MemoryStore({
    repos: db.repos,
    events: new FakeEventBus(),
    config: {
      memory: {
        coreMaxChars: 1500,
        reflect: { enabled: true, idleMinutes: 20, maxMessages: 200, cardMaxChars: 1000 },
        summary: { enabled: true, minMessages: 20, maxChars: 2000 },
      },
    },
    clock: createFakeClock(1_000_000),
    ids: createFakeIds(),
    log: createMemoryLogger(),
  })
  for (const f of FACTS) {
    const m = await memory.write({
      content: f.content,
      subjectPersonId: f.subject,
      visibility: f.visibility,
      threadId: TONY_MAIN,
      source: 'inferred',
      authorPersonId: null,
    })
    ids.set(f.key, m.id)
  }
  for (const content of PEPPER_FACTS) {
    await memory.write({
      content,
      subjectPersonId: PEPPER,
      visibility: 'subject',
      threadId: PEPPER_MAIN,
      source: 'inferred',
      authorPersonId: null,
    })
  }
})

afterAll(() => db.close())

describe('FTS recall corpus (ADR-0014)', () => {
  test('has at least 20 facts and 20 questions, each expecting a known fact', () => {
    expect(FACTS.length).toBeGreaterThanOrEqual(20)
    expect(CASES.length).toBeGreaterThanOrEqual(20)
    for (const c of CASES) expect(FACTS.some((f) => f.key === c.expect)).toBe(true)
  })

  for (const c of CASES) {
    test(`"${c.question}" → recall("${c.query}") has the fact in the top 3`, async () => {
      const found = await memory.recall({ text: c.query, viewer: { participants: [TONY] } })
      const top3 = found.slice(0, 3).map((m) => m.id)
      expect(top3).toContain(ids.get(c.expect) as Memory['id'])
      // I-4: Pepper's private distractors never come back for Tony.
      expect(found.every((m) => m.subjectPersonId !== PEPPER)).toBe(true)
    })
  }

  test('matching is by word: a lone paraphrase with no shared word finds nothing', async () => {
    // Why the memory.recall description asks for several keywords and synonyms.
    const viewer = { participants: [TONY] }
    expect(await memory.recall({ text: 'fly', viewer })).toEqual([])
    expect(await memory.recall({ text: 'satay', viewer })).toEqual([])
    const withSynonyms = await memory.recall({ text: 'fly flight', viewer })
    expect(withSynonyms[0]?.id).toBe(ids.get('flight') as Memory['id'])
  })

  test('hit rate over the corpus is 100% (recorded in the P4-A1 Outcome)', async () => {
    let hits = 0
    for (const c of CASES) {
      const found = await memory.recall({ text: c.query, viewer: { participants: [TONY] } })
      if (
        found
          .slice(0, 3)
          .map((m) => m.id)
          .includes(ids.get(c.expect) as Memory['id'])
      )
        hits++
    }
    expect(hits / CASES.length).toBe(1)
  })
})

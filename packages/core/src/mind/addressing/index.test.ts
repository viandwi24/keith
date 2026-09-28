// P5-K1: the placeholder keeps the phase-4 behavior. P5-D1 replaces it (and this test) with the
// rule pass and the classifier.

import { expect, test } from 'bun:test'
import { createMemoryLogger } from '@keith/sdk/testing'
import { createFakeScheduler, testConfig } from '../testing/fakes.ts'
import { PEPPER } from '../testing/harness.ts'
import { createAddressing } from './index.ts'

test('the placeholder answers addressed for every input (by default)', async () => {
  const detector = createAddressing({
    config: testConfig(),
    runLoop: async () => {
      throw new Error('the placeholder never calls the model')
    },
    scheduler: createFakeScheduler(),
    log: createMemoryLogger(),
  })
  const verdict = await detector.decide({
    threadId: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31',
    input: { authorPersonId: PEPPER, text: 'Rhodey, are you on your way?' },
    recent: [],
    participantNames: ['Tony', 'Pepper', 'Rhodey'],
    signal: new AbortController().signal,
  })
  expect(verdict).toEqual({ addressed: true, by: 'default' })
})

import { afterEach, describe, expect, test } from 'bun:test'
import {
  type LlmEvent,
  type LlmProvider,
  type LlmRequest,
  ProviderError,
} from '../../packages/sdk/src/index.ts'
import {
  addPerson,
  connectNode,
  createHome,
  e2eClock,
  startKeith,
  TEST_TIMEOUT_MS,
  transcriptOf,
  WAIT_MS,
} from './harness.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const WORK_A = 'Work A: draft the Mark 50 nanotech spec.'
const WORK_B = 'Work B: prepare the board meeting agenda.'
const TONY_TONE = 'dry wit, call him sir'
const PEPPER_TONE = 'warm and precise, call her Ms. Potts'

/**
 * A chat model whose replies stop halfway until `parties` replies are streaming at the same time.
 * If the core ran the turns one after the other, the first would wait forever, so the barrier
 * fails loudly instead.
 */
function barrierModel(parties: number): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = []
  let arrived = 0
  let release = () => {}
  const allThere = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    id: 'fake',
    requests,
    async *stream(req, signal): AsyncIterable<LlmEvent> {
      requests.push(structuredClone(req))
      const who = transcriptOf(req).includes(WORK_A) ? 'A' : 'B'
      yield { type: 'text.delta', text: `On work ${who}, ` }
      arrived += 1
      if (arrived === parties) release()
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new ProviderError('unknown', 'the turns did not stream concurrently')),
          WAIT_MS,
        )
        signal.addEventListener('abort', () => reject(new ProviderError('aborted', 'aborted')), {
          once: true,
        })
        void allThere.then(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      yield { type: 'text.delta', text: 'done.' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

describe('S-4: two people, two conversations, one mind', () => {
  test(
    'S-4 / I-3: two persons send at the same time; both turns stream concurrently with separate contexts',
    async () => {
      const home = await createHome()
      cleanups.push(() => home.remove())
      const clock = e2eClock()
      const model = barrierModel(2)
      const { keith } = await startKeith({ home, clock, provider: model })
      cleanups.push(() => keith.stop())
      const tony = await addPerson(keith, clock, { name: 'Tony', tier: 'owner', tone: TONY_TONE })
      const pepper = await addPerson(keith, clock, { name: 'Pepper', tier: 'member', tone: PEPPER_TONE })

      const laptop = await connectNode(keith, tony)
      cleanups.push(() => laptop.close())
      const phone = await connectNode(keith, pepper)
      cleanups.push(() => phone.close())
      const [a, b] = await Promise.all([laptop.openMain(), phone.openMain()])
      expect(a.threadId).not.toBe(b.threadId)

      laptop.say(a.threadId, WORK_A)
      phone.say(b.threadId, WORK_B)

      // Both replies are mid-stream before either completes.
      const [deltaA, deltaB] = await Promise.all([
        laptop.next('message.delta', (f) => f.data.threadId === a.threadId),
        phone.next('message.delta', (f) => f.data.threadId === b.threadId),
      ])
      expect(deltaA.data.text).toBe('On work A, ')
      expect(deltaB.data.text).toBe('On work B, ')
      const [replyA, replyB] = await Promise.all([laptop.reply(a.threadId), phone.reply(b.threadId)])
      expect(replyA.content).toBe('On work A, done.')
      expect(replyB.content).toBe('On work B, done.')

      // Each node only saw its own thread.
      expect(laptop.frames.every((f) => !('threadId' in f.data) || f.data.threadId === a.threadId)).toBe(true)
      expect(phone.frames.every((f) => !('threadId' in f.data) || f.data.threadId === b.threadId)).toBe(true)

      // Two independent LLM contexts, each with its own relationship card (tone).
      const reqA = model.requests.find((r) => transcriptOf(r).includes(WORK_A))
      const reqB = model.requests.find((r) => transcriptOf(r).includes(WORK_B))
      expect(reqA?.messages).toEqual([{ role: 'user', content: WORK_A }])
      expect(reqB?.messages).toEqual([{ role: 'user', content: WORK_B }])
      expect(reqA?.system).toContain('- Tony (tier: owner)')
      expect(reqA?.system).toContain(TONY_TONE)
      expect(reqA?.system).not.toContain(PEPPER_TONE)
      expect(reqB?.system).toContain('- Pepper (tier: member)')
      expect(reqB?.system).toContain(PEPPER_TONE)
      expect(reqB?.system).not.toContain(TONY_TONE)
      for (const secret of ['Mark 50', 'Tony']) expect(reqB?.system).not.toContain(secret)
      for (const secret of ['board meeting', 'Pepper']) expect(reqA?.system).not.toContain(secret)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'S-4 / I-4: the awareness digest knows the Mind is busy elsewhere, without private details',
    async () => {
      const home = await createHome()
      cleanups.push(() => home.remove())
      const clock = e2eClock()
      const model = barrierModel(2)
      const { keith } = await startKeith({ home, clock, provider: model })
      cleanups.push(() => keith.stop())
      const tony = await addPerson(keith, clock, { name: 'Tony', tier: 'owner', tone: TONY_TONE })
      const pepper = await addPerson(keith, clock, { name: 'Pepper', tier: 'member', tone: PEPPER_TONE })
      const laptop = await connectNode(keith, tony)
      cleanups.push(() => laptop.close())
      const phone = await connectNode(keith, pepper)
      cleanups.push(() => phone.close())
      const [a, b] = await Promise.all([laptop.openMain(), phone.openMain()])

      // Tony's turn is streaming (held at the barrier) when Pepper's context is built.
      laptop.say(a.threadId, WORK_A)
      await laptop.next('message.delta')
      phone.say(b.threadId, WORK_B)
      await Promise.all([laptop.reply(a.threadId), phone.reply(b.threadId)])

      const reqB = model.requests.find((r) => transcriptOf(r).includes(WORK_B))
      expect(reqB?.system).toContain('with someone else')
      for (const secret of ['Mark 50', 'Tony', TONY_TONE, 'Main']) expect(reqB?.system).not.toContain(secret)
    },
    TEST_TIMEOUT_MS,
  )
})

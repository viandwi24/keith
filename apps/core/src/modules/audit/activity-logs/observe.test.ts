// observeAux (ADR-0032 §1): a model called outside a turn reports each call as a row of the session `aux:<name>:<person>`.
import { describe, expect, test } from 'bun:test'
import { type LogsSettings, LogsSettingsSchema } from '@keith/contracts'
import { generateText } from 'ai'
import { scriptedModel } from 'eharness/testing'
import { until } from '../../../testing/wait.ts'
import type { CaptureRecord } from './capture.ts'
import { auxSessionId, observeAux } from './observe.ts'

const settingsWith = (patch: Partial<LogsSettings> = {}): { get(): LogsSettings } => ({
  get: () => LogsSettingsSchema.parse(patch),
})

const queueOf = () => {
  const rows: CaptureRecord[] = []
  return { rows, queue: { enqueue: (row: CaptureRecord) => void rows.push(row) } }
}

// `scriptedModel` is a language model with one scripted text per step; the model here answers once
const oneAnswer = () => scriptedModel([{ text: 'Found it.' }])

describe('observeAux', () => {
  test('a call outside a turn is stored under aux:<name>:<person> with kind aux and kind other', async () => {
    const { rows, queue } = queueOf()
    const model = observeAux('web-search', 'ana', oneAnswer() as never, {
      queue,
      settings: settingsWith(),
    })
    const result = await generateText({ model, prompt: 'search something' })
    expect(result.text).toBe('Found it.')

    await until(
      'the call row',
      () => rows.length,
      (n) => n === 1,
    )
    const [row] = rows
    expect(row?.session).toMatchObject({
      id: 'aux:web-search:ana',
      kind: 'aux',
      personId: 'ana',
      app: 'Helper',
    })
    expect(row?.call).toMatchObject({
      sessionId: 'aux:web-search:ana',
      kind: 'other',
      status: 'ok',
      trigger: null,
      turnId: null,
      costMicro: null,
      bodyState: 'stored',
    })
    expect(row?.bodies?.request).toBeInstanceOf(Uint8Array)
    expect(row?.bodies?.response).toBeInstanceOf(Uint8Array)
  })

  test('the session id is built from the name and the person, and names the aux kind', () => {
    expect(auxSessionId('web-search', 'ana')).toBe('aux:web-search:ana')
  })

  test('captureBodies off stores the figures only', async () => {
    const { rows, queue } = queueOf()
    const model = observeAux('web-search', 'ana', oneAnswer() as never, {
      queue,
      settings: settingsWith({ captureBodies: false }),
    })
    await generateText({ model, prompt: 'x' })
    await until(
      'the call row',
      () => rows.length,
      (n) => n === 1,
    )
    expect(rows[0]?.call.bodyState).toBe('off')
    expect(rows[0]?.bodies).toBeUndefined()
  })

  test('a throwing queue never fails the call', async () => {
    const model = observeAux('web-search', 'ana', oneAnswer() as never, {
      queue: {
        enqueue: () => {
          throw new Error('disk full')
        },
      },
      settings: settingsWith(),
    })
    const result = await generateText({ model, prompt: 'x' })
    expect(result.text).toBe('Found it.')
  })

  test('an empty name matches no session kind: the row is dropped and the call still answers', async () => {
    const { rows, queue } = queueOf()
    const model = observeAux('', 'ana', oneAnswer() as never, {
      queue,
      settings: settingsWith(),
    })
    const result = await generateText({ model, prompt: 'x' })
    expect(result.text).toBe('Found it.')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(rows).toEqual([])
  })
})

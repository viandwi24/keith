import { describe, expect, test } from 'bun:test'
import { MessageDto } from '@keith/protocol'
import type { AssistantMessageRecord } from '../storage/types.ts'
import { toMessageDto } from './dto.ts'

const assistant: AssistantMessageRecord = {
  id: 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V33',
  threadId: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31',
  role: 'assistant',
  authorPersonId: null,
  nodeId: null,
  modality: 'text',
  content: 'Tony asked me to tell you he will be late.',
  meta: null,
  createdAt: 1,
  toolCalls: null,
  ui: null,
}

describe('toMessageDto (phase 5)', () => {
  test('I-13: meta.relayFrom reaches the DTO, in order', () => {
    const relayFrom = [
      { personId: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z', name: 'Tony' },
      { personId: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V30', name: 'Happy' },
    ] as const
    const dto = toMessageDto({ ...assistant, meta: { proactive: true, relayFrom: [...relayFrom] } })
    expect(dto?.meta).toEqual({ proactive: true, relayFrom: [...relayFrom] })
    expect(MessageDto.safeParse(dto).success).toBe(true)
  })

  test('a message without relays has no relayFrom', () => {
    expect(toMessageDto({ ...assistant, meta: { proactive: true } })?.meta).toEqual({ proactive: true })
  })
})

import { describe, expect, test } from 'bun:test'
import { MessageDto, ThreadDto } from '@keith/protocol'
import type { AssistantMessageRecord, ThreadRecord } from '../storage/types.ts'
import { toMessageDto, toThreadDto } from './dto.ts'

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

describe('toThreadDto (phase 5)', () => {
  const tony = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z', name: 'Tony', tier: 'owner' } as const
  const happy = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V30', name: 'Happy', tier: 'guest' } as const
  const record: ThreadRecord = {
    id: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31',
    kind: 'group',
    slug: null,
    title: 'Expo',
    ownerPersonId: null,
    summary: null,
    purpose: 'Plan the Expo launch.',
    createdAt: 0,
    updatedAt: 5,
  }

  test('a group carries its purpose and former participants', () => {
    const dto = toThreadDto(record, [tony], 'idle', [happy])
    expect(dto).toMatchObject({ purpose: 'Plan the Expo launch.', formerParticipants: [happy] })
    expect(ThreadDto.safeParse(dto).success).toBe(true)
    const plain = toThreadDto({ ...record, purpose: null }, [tony], 'idle')
    expect(plain).not.toHaveProperty('purpose')
    expect(plain.formerParticipants).toEqual([])
  })

  test('a direct thread has neither field', () => {
    const direct: ThreadRecord = { ...record, kind: 'direct', slug: 'main', purpose: null }
    const dto = toThreadDto(direct, [tony], 'idle', [happy])
    expect(dto).not.toHaveProperty('purpose')
    expect(dto).not.toHaveProperty('formerParticipants')
  })
})

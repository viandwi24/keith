import { describe, expect, test } from 'bun:test'
import {
  HealthResponse,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  MeResponse,
  MessageDto,
  MessagesQuery,
  MessagesResponse,
  PersonDto,
  ThreadDto,
  ThreadsResponse,
} from './dto.ts'
import { HttpErrorBody } from './errors.ts'

const person = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V2Z', name: 'Tony', tier: 'owner' } as const
const thread = {
  id: 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31',
  kind: 'direct',
  title: 'main',
  participants: [person],
  state: 'idle',
  updatedAt: 1,
} as const
const message = {
  id: 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V33',
  threadId: thread.id,
  role: 'user',
  authorPersonId: person.id,
  modality: 'text',
  content: 'hi',
  createdAt: 1,
} as const

describe('DTOs', () => {
  test('PersonDto', () => {
    expect(PersonDto.parse(person)).toEqual(person)
    expect(PersonDto.safeParse({ ...person, tier: 'admin' }).success).toBe(false)
  })

  test('ThreadDto requires at least one participant (I-2)', () => {
    expect(ThreadDto.safeParse(thread).success).toBe(true)
    expect(ThreadDto.safeParse({ ...thread, participants: [] }).success).toBe(false)
  })

  test('MessageDto: author null means the Mind (I-2)', () => {
    expect(MessageDto.safeParse({ ...message, role: 'assistant', authorPersonId: null }).success).toBe(true)
    expect(MessageDto.safeParse({ ...message, authorPersonId: undefined }).success).toBe(false)
  })

  test('MessageDto: modality is a property of the message (I-6)', () => {
    expect(MessageDto.safeParse({ ...message, modality: 'audio' }).success).toBe(true)
    expect(MessageDto.safeParse({ ...message, modality: 'video' }).success).toBe(false)
  })

  test('MessageDto: tool messages are never sent to nodes', () => {
    expect(MessageDto.safeParse({ ...message, role: 'tool' }).success).toBe(false)
  })

  test('MessageDto: ui blocks are validated', () => {
    const ui = [{ type: 'markdown', id: 'a', text: 'x' }]
    expect(MessageDto.safeParse({ ...message, ui }).success).toBe(true)
    expect(
      MessageDto.safeParse({ ...message, ui: [{ type: 'markdown', id: 'A!', text: 'x' }] }).success,
    ).toBe(false)
  })
})

describe('HTTP bodies', () => {
  test('health', () => {
    expect(HealthResponse.safeParse({ ok: true, version: '0.1.0', protocol: 1 }).success).toBe(true)
    expect(HealthResponse.safeParse({ ok: true, version: '0.1.0', protocol: 2 }).success).toBe(false)
  })

  test('login', () => {
    expect(LoginRequest.safeParse({ username: 'tony', password: 'pw' }).success).toBe(true)
    expect(LoginRequest.safeParse({ username: '', password: 'pw' }).success).toBe(false)
    expect(LoginResponse.safeParse({ token: 't', person, expiresAt: 2 }).success).toBe(true)
    expect(LoginResponse.safeParse({ token: 't', person }).success).toBe(false)
  })

  test('logout, me, threads', () => {
    expect(LogoutResponse.safeParse({ ok: true }).success).toBe(true)
    expect(MeResponse.safeParse({ person }).success).toBe(true)
    expect(ThreadsResponse.safeParse({ threads: [thread] }).success).toBe(true)
  })

  test('messages query coerces strings and applies the default limit', () => {
    expect(MessagesQuery.parse({})).toEqual({ limit: 50 })
    expect(MessagesQuery.parse({ limit: '10', before: message.id })).toEqual({
      limit: 10,
      before: message.id,
    })
    expect(MessagesQuery.safeParse({ limit: '201' }).success).toBe(false)
    expect(MessagesQuery.safeParse({ limit: '0' }).success).toBe(false)
    expect(MessagesQuery.safeParse({ before: thread.id }).success).toBe(false)
  })

  test('messages response', () => {
    expect(MessagesResponse.safeParse({ messages: [message], hasMore: false }).success).toBe(true)
    expect(MessagesResponse.safeParse({ messages: [message] }).success).toBe(false)
  })

  test('error body', () => {
    expect(HttpErrorBody.safeParse({ error: { code: 'NOT_FOUND', message: 'no thread' } }).success).toBe(true)
    expect(HttpErrorBody.safeParse({ error: { code: 'NOPE', message: 'x' } }).success).toBe(false)
  })
})

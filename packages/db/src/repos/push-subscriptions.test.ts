import { expect, test } from 'bun:test'
import { migrateDatabase, openDatabase } from '../connection.ts'
import { pushSubscriptionsRepo } from './push-subscriptions.ts'

function repo() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return pushSubscriptionsRepo(sqlite)
}

const sub = (id: string, personId: string, endpoint: string, at = 1) => ({
  id,
  personId,
  endpoint,
  p256dh: 'p',
  auth: 'a',
  label: 'phone',
  userAgent: 'ua',
  createdAt: at,
})

test('upsert stores a row, lists it for its person only and counts it', () => {
  const r = repo()
  r.upsert(sub('s1', 'ana', 'https://push.example/1'))
  r.upsert(sub('s2', 'ben', 'https://push.example/2'))
  expect(r.listFor('ana').map((x) => x.id)).toEqual(['s1'])
  expect(r.countFor('ana')).toBe(1)
  expect(r.get('s2')?.personId).toBe('ben')
})

test('an endpoint is unique: a second upsert updates the row and resets failures', () => {
  const r = repo()
  r.upsert(sub('s1', 'ana', 'https://push.example/1', 1))
  r.markFailure('s1')
  const again = r.upsert({ ...sub('s9', 'ana', 'https://push.example/1', 5), label: 'tablet' })
  expect(again.id).toBe('s1')
  expect(again.createdAt).toBe(1)
  expect(again.label).toBe('tablet')
  expect(again.failureCount).toBe(0)
  expect(r.countFor('ana')).toBe(1)
})

test('success and failure marks, delete and deleteFor', () => {
  const r = repo()
  r.upsert(sub('s1', 'ana', 'https://push.example/1'))
  r.upsert(sub('s2', 'ana', 'https://push.example/2'))
  expect(r.markFailure('s1')).toBe(1)
  expect(r.markFailure('s1')).toBe(2)
  expect(r.markFailure('nope')).toBeUndefined()
  r.markSuccess('s1', 99)
  expect(r.get('s1')).toMatchObject({ lastSuccessAt: 99, failureCount: 0 })
  expect(r.delete('s1')).toBe(true)
  expect(r.delete('s1')).toBe(false)
  expect(r.deleteFor('ana')).toBe(1)
  expect(r.byEndpoint('https://push.example/2')).toBeUndefined()
})

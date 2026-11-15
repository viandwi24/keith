import { describe, expect, test } from 'bun:test'
import type { AuditEvent } from '@keith/contracts'
import { auditChoices, filterAudit, isFiltered, NO_AUDIT_FILTER } from './audit-filter.ts'

const ev = (id: number, over: Partial<AuditEvent> = {}): AuditEvent => ({
  id,
  at: id,
  kind: 'auth.login',
  actor: 'ana',
  via: 'tcp',
  detail: {},
  ...over,
})

const events = [
  ev(1),
  ev(2, { kind: 'people.add', actor: 'owner', via: 'local', detail: { person: 'bo' } }),
  ev(3, { kind: 'people.remove', actor: 'owner', detail: { person: 'cy' } }),
]

describe('filterAudit', () => {
  test('no filter keeps everything in order', () => {
    expect(filterAudit(events, NO_AUDIT_FILTER).map((e) => e.id)).toEqual([1, 2, 3])
    expect(isFiltered(NO_AUDIT_FILTER)).toBe(false)
  })

  test('kind, actor and route narrow together', () => {
    expect(
      filterAudit(events, { ...NO_AUDIT_FILTER, actor: 'owner', via: 'local' }).map((e) => e.id),
    ).toEqual([2])
    expect(
      filterAudit(events, { ...NO_AUDIT_FILTER, kind: 'auth.login' }).map((e) => e.id),
    ).toEqual([1])
  })

  test('a word reads the kind, the actor and the detail, case aside', () => {
    expect(filterAudit(events, { ...NO_AUDIT_FILTER, q: 'CY' }).map((e) => e.id)).toEqual([3])
    expect(filterAudit(events, { ...NO_AUDIT_FILTER, q: 'people.' }).map((e) => e.id)).toEqual([
      2, 3,
    ])
  })
})

describe('auditChoices', () => {
  test('distinct and sorted', () => {
    expect(auditChoices(events, 'actor')).toEqual(['ana', 'owner'])
    expect(auditChoices(events, 'via')).toEqual(['local', 'tcp'])
  })
})

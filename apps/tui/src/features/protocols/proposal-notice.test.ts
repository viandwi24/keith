import { describe, expect, test } from 'bun:test'
import type { ProtocolProposal } from '@keith/contracts'
import { reminderDefinition } from '../manage/protocols/protocols-reminder.ts'
import { freshProposals, proposalLine } from './proposal-notice.ts'

const proposal = (over: Partial<ProtocolProposal>): ProtocolProposal => ({
  id: 'p',
  person: 'ana-id',
  definition: reminderDefinition('Stretch', Date.UTC(2026, 10, 10, 15)),
  reason: 'Stretch every afternoon',
  status: 'pending',
  createdAt: 1,
  expiresAt: 2,
  ...over,
})

describe('freshProposals', () => {
  test('each pending proposal is announced once, oldest first', () => {
    const seen = new Set<string>()
    const list = [proposal({ id: 'b', createdAt: 5 }), proposal({ id: 'a', createdAt: 3 })]
    expect(freshProposals(list, seen).map((p) => p.id)).toEqual(['a', 'b'])
    expect(freshProposals(list, seen)).toEqual([])
    expect(seen).toEqual(new Set(['a', 'b']))
  })

  test('a confirmed, dismissed or expired proposal is never announced', () => {
    const list = ['confirmed', 'dismissed', 'expired'].map((status, i) =>
      proposal({ id: `s${i}`, status: status as ProtocolProposal['status'] }),
    )
    expect(freshProposals(list, new Set())).toEqual([])
  })
})

describe('proposalLine', () => {
  test('one line: the reason and where to answer it; a long reason is cut', () => {
    expect(proposalLine(proposal({}))).toBe(
      'new protocol proposal: Stretch every afternoon · Apps > Protocols',
    )
    const long = proposalLine(proposal({ reason: 'x'.repeat(200) }))
    expect(long.length).toBeLessThan(120)
    expect(long).toContain('…')
  })
})

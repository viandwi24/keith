import { describe, expect, test } from 'bun:test'
import { declaresSource, eharnessConsentRisk, toolReversible, toolSource } from './tool-source.ts'

describe('toolSource', () => {
  test.each([
    ['declared trusted', { source: 'trusted' }, 'x', 'trusted'],
    ['declared outside', { source: 'outside' }, 'x', 'outside'],
    ['declared wins over the eharness table', { source: 'trusted' }, 'web_fetch', 'trusted'],
    ['an invalid value counts as undeclared', { source: 'nope' }, 'x', 'outside'],
    ['no metadata, unknown tool', undefined, 'x', 'outside'],
    ['no metadata, an eharness tool by name', undefined, 'datetime', 'trusted'],
    ['no metadata, web_fetch', null, 'web_fetch', 'outside'],
    ['no metadata, a delegation', {}, 'agent', 'outside'],
    ['a prototype key is not a tool', {}, 'constructor', 'outside'],
  ])('%s', (_name, metadata, toolName, expected) => {
    expect(toolSource(metadata, toolName)).toBe(expected as never)
  })
})

describe('declaresSource and toolReversible', () => {
  test('only a valid source counts as declared', () => {
    expect(declaresSource({ source: 'trusted' })).toBe(true)
    expect(declaresSource({ source: 'x' })).toBe(false)
    expect(declaresSource(undefined)).toBe(false)
  })
  test('reversible is exactly true', () => {
    expect(toolReversible({ reversible: true })).toBe(true)
    expect(toolReversible({ reversible: 'yes' })).toBe(false)
    expect(toolReversible({ risk: 'write' })).toBe(false)
    expect(toolReversible(null)).toBe(false)
  })
  test('the web tools read as read for consent, other tools have no override', () => {
    expect(eharnessConsentRisk('web_fetch')).toBe('read')
    expect(eharnessConsentRisk('web_search')).toBe('read')
    expect(eharnessConsentRisk('agent')).toBeUndefined()
    expect(eharnessConsentRisk('toString')).toBeUndefined()
  })
})

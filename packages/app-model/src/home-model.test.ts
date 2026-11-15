import { describe, expect, test } from 'bun:test'
import type { BrainEvent } from '@keith/contracts'
import { REGIONS } from '@keith/ui/orb'
import { orbModeOf, plainText, regionOf, strengthOf } from './home-model.ts'

const calm = { alert: false, busy: false, speaking: false, typing: false }

describe('orbModeOf', () => {
  test('idle, listening, thinking, speaking and alert from real state', () => {
    expect(orbModeOf(calm)).toBe('idle')
    expect(orbModeOf({ ...calm, typing: true })).toBe('listening')
    expect(orbModeOf({ ...calm, busy: true })).toBe('thinking')
    expect(orbModeOf({ ...calm, busy: true, speaking: true })).toBe('speaking')
    expect(orbModeOf({ ...calm, alert: true, busy: true, speaking: true, typing: true })).toBe(
      'alert',
    )
  })

  test('a running turn outranks the draft', () => {
    expect(orbModeOf({ ...calm, busy: true, typing: true })).toBe('thinking')
  })
})

describe('events to the trace', () => {
  const event = (type: string): BrainEvent => ({ type, payload: {} }) as unknown as BrainEvent
  test('the region is the second part of the type and is always a trace region', () => {
    expect(regionOf(event('brain.cortex.step'))).toBe('cortex')
    expect(REGIONS).toContain(regionOf(event('brain.hippocampus.recall')))
    expect(regionOf(event('brain.parietal.presence'))).toBe('parietal')
    expect(REGIONS).toContain(regionOf(event('brain.parietal.deliver')))
  })

  test('a step is small, a spoken answer or a motor act is larger', () => {
    const step = strengthOf(event('brain.cortex.step'))
    expect(step).toBeLessThan(strengthOf(event('brain.amygdala.decide')))
    expect(strengthOf(event('brain.amygdala.decide'))).toBeLessThan(
      strengthOf(event('brain.broca.start')),
    )
    expect(strengthOf(event('brain.motor.act'))).toBeGreaterThan(step)
  })
})

describe('plainText', () => {
  test('strips markdown down to the words', () => {
    expect(plainText('# Title\n\nSome **bold** and *soft* `code` [link](http://x).')).toBe(
      'Title Some bold and soft code link.',
    )
    expect(plainText('- one\n- two\n\n```ts\nconst a = 1\n```\nend')).toBe('one two end')
    expect(plainText('snake_case_word stays')).toBe('snake_case_word stays')
  })
})

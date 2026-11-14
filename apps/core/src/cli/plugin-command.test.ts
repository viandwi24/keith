import { describe, expect, test } from 'bun:test'
import { stateText } from './plugin-command.ts'

describe('plugin status text', () => {
  test('a plugin whose setting matches what runs shows its state alone', () => {
    expect(stateText({ state: 'enabled', nextBoot: 'enabled', restartPending: false })).toBe(
      'enabled',
    )
  })

  test('a toggled plugin says what it will be at the next boot', () => {
    expect(stateText({ state: 'enabled', nextBoot: 'disabled', restartPending: true })).toBe(
      'enabled (disabled at next boot)',
    )
  })
})

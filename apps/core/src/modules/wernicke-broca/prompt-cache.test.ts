import { describe, expect, test } from 'bun:test'
import type { LanguageModel } from 'ai'
import { isRoutedAnthropic } from './prompt-cache.ts'

const model = (provider: string, modelId: string) =>
  ({ provider, modelId }) as unknown as LanguageModel

describe('prompt cache: routed Anthropic models', () => {
  test('Claude through OpenRouter gets the markers', () => {
    expect(isRoutedAnthropic(model('openrouter.chat', 'anthropic/claude-sonnet-4.6'))).toBe(true)
  })

  test('other OpenRouter models, other providers and gateway strings do not', () => {
    expect(isRoutedAnthropic(model('openrouter.chat', 'deepseek/deepseek-chat'))).toBe(false)
    expect(isRoutedAnthropic(model('deepseek.chat', 'deepseek-chat'))).toBe(false)
    expect(isRoutedAnthropic('anthropic/claude-sonnet-4.6')).toBe(false)
  })
})

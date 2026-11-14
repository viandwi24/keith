import { describe, expect, test } from 'bun:test'
import { ModelRefSchema } from './models.ts'
import { ConnectionInputSchema, ConnectionSchema } from './providers.ts'

describe('provider wire shapes', () => {
  test('a model reference needs a connection and a model', () => {
    expect(ModelRefSchema.safeParse('openrouter:anthropic/claude-haiku-5.5').success).toBe(true)
    expect(ModelRefSchema.safeParse('anthropic/claude-haiku-5.5').success).toBe(false)
  })

  test('connection ids are slugs (no `:`, it separates the model)', () => {
    expect(ConnectionInputSchema.safeParse({ id: 'openrouter-2' }).success).toBe(true)
    expect(ConnectionInputSchema.safeParse({ id: 'open:router' }).success).toBe(false)
  })

  test('a connection carries a redacted secret status', () => {
    const parsed = ConnectionSchema.parse({
      id: 'openrouter',
      providerId: 'openrouter',
      label: 'OpenRouter',
      enabled: true,
      source: 'store',
      settings: { apiKey: { set: true, hint: '…abcd' } },
      updatedAt: 1,
    })
    expect(parsed.settings.apiKey).toEqual({ set: true, hint: '…abcd' })
  })
})

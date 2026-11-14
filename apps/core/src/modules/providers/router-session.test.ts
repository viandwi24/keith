import { describe, expect, test } from 'bun:test'
import type { LanguageModel } from 'ai'
import { routerSessionOptions } from './router-session.ts'

const model = (provider: string) => ({ provider, modelId: 'x' }) as unknown as LanguageModel

describe('router session: OpenRouter sticky routing', () => {
  test('an OpenRouter model gets a stable, opaque session id per session', () => {
    const a = routerSessionOptions('front:person-1:0', model('openrouter.chat'))
    expect(a?.openrouter.session_id).toMatch(/^[0-9a-f]{32}$/)
    expect(routerSessionOptions('front:person-1:0', model('openrouter.chat'))).toEqual(a)
    expect(routerSessionOptions('front:person-1:1', model('openrouter.chat'))).not.toEqual(a)
    expect(JSON.stringify(a)).not.toContain('person-1')
  })

  test('other providers and gateway strings get nothing', () => {
    expect(routerSessionOptions('s', model('deepseek.chat'))).toBeUndefined()
    expect(routerSessionOptions('s', 'anthropic/claude')).toBeUndefined()
  })
})

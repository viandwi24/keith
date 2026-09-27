import { describe, expect, test } from 'bun:test'
import { buildChatBody, toWireAuthorName } from './request.ts'
import { fromWireToolName, toWireToolName } from './wire.ts'

describe('buildChatBody', () => {
  test('maps system, messages, tools and limits to a streaming chat/completions body', () => {
    const body = buildChatBody({
      model: 'vendor/model',
      system: 'You are Keith.',
      messages: [
        { role: 'user', content: 'Find venues', name: 'Anna Müller' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_1', name: 'web.search', args: { q: 'venues' } },
            { id: 'call_2', name: 'web.fetch', args: { __raw: '{"url":' } },
          ],
        },
        { role: 'tool', toolCallId: 'call_1', content: '3 results' },
        { role: 'assistant', content: 'Here they are.' },
      ],
      tools: [{ name: 'web.search', description: 'Search the web.', inputSchema: { type: 'object' } }],
      temperature: 0.3,
      maxOutputTokens: 512,
      reasoning: 'high',
    })
    expect(body).toEqual({
      model: 'vendor/model',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'You are Keith.' },
        { role: 'user', content: 'Find venues', name: 'Anna_M_ller' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'web__search', arguments: '{"q":"venues"}' },
            },
            { id: 'call_2', type: 'function', function: { name: 'web__fetch', arguments: '{"url":' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '3 results' },
        { role: 'assistant', content: 'Here they are.' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'web__search', description: 'Search the web.', parameters: { type: 'object' } },
        },
      ],
      temperature: 0.3,
      max_tokens: 512,
    })
  })

  test('omits an empty system prompt, empty tools and unset options', () => {
    const body = buildChatBody({
      model: 'm',
      system: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    })
    expect(body).toEqual({
      model: 'm',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    })
  })

  test('drops an author name with no usable characters', () => {
    expect(toWireAuthorName('李雷')).toBeUndefined()
    expect(toWireAuthorName('x'.repeat(80))).toHaveLength(64)
  })
})

describe('tool name mapping', () => {
  test('maps dots to double underscores and back', () => {
    for (const name of ['web.search', 'calendar.add_event', 'a.b_c.d']) {
      expect(toWireToolName(name)).toMatch(/^[a-zA-Z0-9_-]+$/)
      expect(fromWireToolName(toWireToolName(name))).toBe(name)
    }
  })
})

/** Maps a Keith `LlmRequest` to an OpenAI-compatible `chat/completions` streaming body. */
import type { LlmMessage, LlmRequest, LlmToolCall } from '../types.ts'
import { toWireToolName } from './wire.ts'

/** OpenAI allows only `^[a-zA-Z0-9_-]{1,64}$` in a message `name`. */
export function toWireAuthorName(name: string): string | undefined {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64)
  return cleaned.replaceAll('_', '') === '' ? undefined : cleaned
}

function toWireArguments(args: unknown): string {
  if (typeof args === 'object' && args !== null && '__raw' in args && typeof args.__raw === 'string') {
    return args.__raw
  }
  return JSON.stringify(args ?? {})
}

function toWireToolCall(call: LlmToolCall): Record<string, unknown> {
  return {
    id: call.id,
    type: 'function',
    function: { name: toWireToolName(call.name), arguments: toWireArguments(call.args) },
  }
}

function toWireMessage(message: LlmMessage): Record<string, unknown> {
  switch (message.role) {
    case 'user': {
      const name = message.name === undefined ? undefined : toWireAuthorName(message.name)
      return name === undefined
        ? { role: 'user', content: message.content }
        : { role: 'user', content: message.content, name }
    }
    case 'assistant': {
      const calls = message.toolCalls ?? []
      if (calls.length === 0) return { role: 'assistant', content: message.content }
      return {
        role: 'assistant',
        content: message.content === '' ? null : message.content,
        tool_calls: calls.map(toWireToolCall),
      }
    }
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
  }
}

/**
 * The default request body. `reasoning` is not mapped here because every vendor spells it
 * differently; provider plugins map it in `mapRequest`.
 */
export function buildChatBody(req: LlmRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  if (req.system !== '') messages.push({ role: 'system', content: req.system })
  for (const message of req.messages) messages.push(toWireMessage(message))
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      type: 'function',
      function: {
        name: toWireToolName(tool.name),
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }))
  }
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.maxOutputTokens !== undefined) body.max_tokens = req.maxOutputTokens
  return body
}

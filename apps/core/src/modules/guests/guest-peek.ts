import { stripControl } from '@keith/cli'
import type { GuestPeek, GuestPeekMessage } from '@keith/contracts'

/** The newest messages a peek shows. */
export const PEEK_MESSAGES = 100

interface WireMessage {
  role?: string
  parts?: Array<{ type: string; text?: string; toolName?: string }>
}

/**
 * One stored message as the owner reads it: text parts joined, tool calls by name; other roles and empty messages
 * are skipped. A visitor's text is inert here: control and escape sequences are removed (a stranger cannot write to
 * the owner's terminal, FD10-02). Newlines stay, so the CLI can indent the continuation lines. The stored message
 * is not changed; the renderers strip again on their own (P23.1.11).
 */
export function peekMessageOf(message: WireMessage): GuestPeekMessage | undefined {
  if (message.role !== 'user' && message.role !== 'assistant') return undefined
  const parts = message.parts ?? []
  const text = stripControl(
    parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join(''),
    { newlines: true },
  )
  const tools = parts
    .filter((p) => p.type.startsWith('tool-') || p.type === 'dynamic-tool')
    .map((p) =>
      stripControl(
        p.type === 'dynamic-tool' ? (p.toolName ?? 'tool') : p.type.slice('tool-'.length),
      ),
    )
  if (text === '' && tools.length === 0) return undefined
  return { role: message.role, text, ...(tools.length === 0 ? {} : { tools }) }
}

export function peekOf(
  base: { id: string; turns: number; expiresAt: number },
  messages: readonly WireMessage[],
): GuestPeek {
  const shown = messages.flatMap((m) => peekMessageOf(m) ?? [])
  return {
    ...base,
    messages: shown.slice(-PEEK_MESSAGES),
    truncated: shown.length > PEEK_MESSAGES,
  }
}

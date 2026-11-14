/**
 * What a visitor's chat stream may carry (docs/specs/guests.md, "Guest HTTP"). eharness streams the model id, token
 * counts and cost, the context window and warnings next to the answer; a visitor learns none of it. The scrub is an
 * **allow-list** of chunk types, applied to every event of a `text/event-stream` answer: anything not listed is dropped,
 * message metadata is cut down to the stop reason, and error text is replaced by the persona's guest line (`prefrontal/lines.ts`,
 * read at each error, so a template switch applies at once).
 */
import { FALLBACK_LINES } from '../prefrontal/index.ts'

/** Chunk types that carry the answer, the tool calls the visitor's own question caused, and the turn's shape. */
const PASS = new Set([
  'start',
  'start-step',
  'finish-step',
  'finish',
  'abort',
  'text-start',
  'text-delta',
  'text-end',
  'tool-input-start',
  'tool-input-delta',
  'tool-input-available',
  'tool-input-error',
  'tool-output-available',
  'tool-output-error',
  'tool-output-denied',
  'message-metadata',
  // the "thinking" indicator only: its data is a state and a step number
  'data-eh.status',
])

/**
 * The text a visitor sees for any failure of a turn: provider and internal messages stay with the owner. The default is the
 * `professional` template's line; the core passes the persona's line (`guestUnavailableLine`).
 */
export const GUEST_ERROR_TEXT = FALLBACK_LINES.guestUnavailable

/** Reads the visitor's error text at the time of the error. */
export type GuestLine = () => string

type Chunk = Record<string, unknown>

/** The scrubbed chunk, or undefined when it must not reach a visitor. */
export function scrubChunk(
  chunk: Chunk,
  line: GuestLine = () => GUEST_ERROR_TEXT,
): Chunk | undefined {
  const type = chunk.type
  if (typeof type !== 'string') return undefined
  if (type === 'error') return { type: 'error', errorText: line() }
  if (!PASS.has(type)) return undefined
  const out: Chunk = { ...chunk }
  if ('messageMetadata' in out) {
    const stop = (out.messageMetadata as { eharness?: { stop?: unknown } } | undefined)?.eharness
      ?.stop
    if (typeof stop === 'string') out.messageMetadata = { eharness: { stop } }
    else delete out.messageMetadata
    // a metadata chunk with nothing left says nothing
    if (type === 'message-metadata' && !('messageMetadata' in out)) return undefined
  }
  // a model's own reasoning, provider signatures and raw provider payloads are not for visitors
  delete out.providerMetadata
  delete out.providerExecuted
  if (type === 'tool-output-error' && typeof out.errorText === 'string')
    out.errorText = String(out.errorText).slice(0, 200)
  return out
}

/** One SSE event (the lines between blank lines) scrubbed; undefined when it is dropped. */
export function scrubEvent(event: string, line?: GuestLine): string | undefined {
  const data = event
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''))
    .join('\n')
  if (data === '') return undefined // a comment or keep-alive line: nothing a visitor needs
  if (data === '[DONE]') return 'data: [DONE]\n\n'
  try {
    const kept = scrubChunk(JSON.parse(data) as Chunk, line)
    return kept === undefined ? undefined : `data: ${JSON.stringify(kept)}\n\n`
  } catch {
    return undefined
  }
}

/** The response with its event stream scrubbed (other bodies, and errors, pass as they are). */
export function scrubResponse(response: Response, line?: GuestLine): Response {
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('text/event-stream') || response.body === null) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true })
      let at = buffer.indexOf('\n\n')
      while (at >= 0) {
        const kept = scrubEvent(buffer.slice(0, at), line)
        if (kept !== undefined) controller.enqueue(encoder.encode(kept))
        buffer = buffer.slice(at + 2)
        at = buffer.indexOf('\n\n')
      }
    },
    flush(controller) {
      const kept = buffer.trim() === '' ? undefined : scrubEvent(buffer, line)
      if (kept !== undefined) controller.enqueue(encoder.encode(kept))
    },
  })
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

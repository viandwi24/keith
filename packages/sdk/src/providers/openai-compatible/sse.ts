/**
 * A minimal Server-Sent Events reader for OpenAI-compatible streams: yields the `data` payload of
 * each event. Comment lines (`: OPENROUTER PROCESSING`) and other fields are ignored, multi-line
 * `data:` fields are joined with `\n`, and `\n`, `\r\n` and `\r` all end a line
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation).
 */

/** Feeds text in, gets complete event payloads out. Exposed for tests and custom transports. */
export class SseDecoder {
  private buffer = ''
  private data: string[] = []
  private pendingCr = false

  /** Adds a piece of the stream and returns the payloads of the events it completed. */
  push(text: string): string[] {
    let input = text
    if (this.pendingCr && input.startsWith('\n')) input = input.slice(1)
    this.pendingCr = false
    this.buffer += input
    const out: string[] = []
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer)
      if (!match) break
      // A trailing '\r' may be the first half of '\r\n': wait for the next piece.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) {
        this.pendingCr = true
        const line = this.buffer.slice(0, match.index)
        this.buffer = ''
        this.line(line, out)
        break
      }
      const line = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      this.line(line, out)
    }
    return out
  }

  /** Ends the stream. An unterminated last event is still delivered (lenient). */
  end(): string[] {
    const out: string[] = []
    if (this.buffer.length > 0) this.line(this.buffer, out)
    this.buffer = ''
    this.line('', out)
    return out
  }

  private line(line: string, out: string[]): void {
    if (line === '') {
      if (this.data.length > 0) out.push(this.data.join('\n'))
      this.data = []
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    if (field !== 'data') return
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    this.data.push(value)
  }
}

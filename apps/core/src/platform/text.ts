/** Head and tail of a long text: the start and the end of a log are what matters. */
export function capHeadTail(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil(max * 0.6)
  const tail = max - head
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n… [${omitted} characters omitted] …\n${text.slice(text.length - tail)}`
}

/**
 * Collects streamed text in bounded memory: the first `head` characters and the last `tail`
 * characters survive; `text()` marks what was dropped in between.
 */
export class HeadTail {
  private head = ''
  private tail = ''
  private dropped = 0

  constructor(
    private readonly headMax: number,
    private readonly tailMax: number,
  ) {}

  push(chunk: string): void {
    let rest = chunk
    if (this.head.length < this.headMax) {
      const room = this.headMax - this.head.length
      this.head += rest.slice(0, room)
      rest = rest.slice(room)
    }
    if (rest === '') return
    const combined = this.tail + rest
    if (combined.length > this.tailMax) {
      this.dropped += combined.length - this.tailMax
      this.tail = combined.slice(combined.length - this.tailMax)
    } else {
      this.tail = combined
    }
  }

  text(): string {
    return this.dropped === 0
      ? this.head + this.tail
      : `${this.head}\n… [${this.dropped} characters omitted] …\n${this.tail}`
  }
}

// Output cap of a call: the head and the tail of the text, 30 000 characters in all, like `shell.exec` (the node's
// executor/output-cap.ts). A driver cannot import the node app, so the rule is written again here.
export const OUTPUT_CAP = 30_000

export class OutputCollector {
  private head = ''
  private tail = ''
  private total = 0
  private readonly half: number

  constructor(cap: number = OUTPUT_CAP) {
    this.half = Math.floor(cap / 2)
  }

  push(text: string): void {
    this.total += text.length
    let rest = text
    if (this.head.length < this.half) {
      const room = this.half - this.head.length
      this.head += rest.slice(0, room)
      rest = rest.slice(room)
    }
    if (rest.length === 0) return
    this.tail = (this.tail + rest).slice(-this.half)
  }

  get truncated(): boolean {
    return this.total > this.head.length + this.tail.length
  }

  text(): string {
    if (!this.truncated) return this.head + this.tail
    const dropped = this.total - this.head.length - this.tail.length
    return `${this.head}\n[... ${dropped} characters truncated ...]\n${this.tail}`
  }
}

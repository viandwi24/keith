/** Total characters kept in a final output: head plus tail. */
export const OUTPUT_CAP = 30_000

/** Keeps the first and last half of an output stream and drops the middle. */
export class OutputCollector {
  private head = ''
  private tail = ''
  private total = 0
  private readonly half: number

  constructor(cap: number = OUTPUT_CAP) {
    this.half = Math.floor(cap / 2)
  }

  push(chunk: string): void {
    this.total += chunk.length
    let rest = chunk
    if (this.head.length < this.half) {
      const room = this.half - this.head.length
      this.head += rest.slice(0, room)
      rest = rest.slice(room)
    }
    if (rest.length > 0) this.tail = (this.tail + rest).slice(-this.half)
  }

  get truncated(): boolean {
    return this.total > this.head.length + this.tail.length
  }

  /** Head, a marker line when something was dropped, then tail. */
  text(): string {
    if (!this.truncated) return this.head + this.tail
    const dropped = this.total - this.head.length - this.tail.length
    return `${this.head}\n[... ${dropped} characters truncated ...]\n${this.tail}`
  }
}

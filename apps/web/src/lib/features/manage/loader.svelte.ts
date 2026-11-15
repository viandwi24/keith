/** One read the screen shows: its data, its failure (with the RPC code) and whether it is in flight. Only the newest read may write. */
export class Loader<T> {
  data = $state.raw<T | undefined>(undefined)
  error = $state<string | undefined>(undefined)
  code = $state<string | undefined>(undefined)
  loading = $state(false)
  private seq = 0

  async run(read: () => Promise<T>): Promise<void> {
    const mine = ++this.seq
    this.loading = true
    try {
      const value = await read()
      if (mine !== this.seq) return
      this.data = value
      this.error = undefined
      this.code = undefined
    } catch (e) {
      if (mine !== this.seq) return
      this.error = e instanceof Error ? e.message : String(e)
      const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined
      this.code = typeof code === 'string' ? code : undefined
    } finally {
      if (mine === this.seq) this.loading = false
    }
  }
}

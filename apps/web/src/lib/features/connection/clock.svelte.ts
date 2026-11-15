/** A reactive `now` (epoch ms) that ticks while something reads it inside an effect. */
export function createNow(everyMs = 1000): { readonly value: number } {
  let now = $state(Date.now())
  $effect(() => {
    const id = setInterval(() => {
      now = Date.now()
    }, everyMs)
    return () => clearInterval(id)
  })
  return {
    get value() {
      return now
    },
  }
}

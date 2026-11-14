export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Poll `read` until `ok` accepts the value, or fail after `ms`. */
export async function until<T>(
  what: string,
  read: () => T | Promise<T>,
  ok: (value: T) => boolean = Boolean,
  ms = 5000,
): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(10)
  }
}

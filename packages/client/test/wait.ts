/** Polls `predicate` until it holds, or fails after `timeoutMs`. */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

/** Wait until the last Ink frame passes `check` (polls; Ink renders asynchronously). */
export async function frameUntil(
  lastFrame: () => string | undefined,
  check: (frame: string) => boolean,
  timeoutMs = 15_000,
): Promise<string> {
  const start = Date.now()
  for (;;) {
    const frame = lastFrame() ?? ''
    if (check(frame)) return frame
    if (Date.now() - start > timeoutMs) throw new Error(`frame never matched:\n${frame}`)
    await Bun.sleep(15)
  }
}

/** Type a line, one character per write, then Enter. */
export async function typeLine(stdin: { write(data: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch)
    await Bun.sleep(2)
  }
  await Bun.sleep(10)
  stdin.write('\r')
  await Bun.sleep(20)
}

/**
 * Press a key and wait for the frame to pass `check`. Ink attaches a component's `useInput`
 * handler in an effect, so on a slow machine a key written right after a screen rendered can
 * arrive before the handler is active and is dropped. The key is written again, but only while
 * the frame is still the one the key was meant to change, so a handled key is never repeated.
 */
export async function pressUntil(
  stdin: { write(data: string): void },
  lastFrame: () => string | undefined,
  key: string,
  check: (frame: string) => boolean,
  { timeoutMs = 15_000, retryMs = 400 } = {},
): Promise<string> {
  const before = lastFrame() ?? ''
  const start = Date.now()
  let lastWrite = 0
  for (;;) {
    const frame = lastFrame() ?? ''
    if (check(frame)) return frame
    const now = Date.now()
    if (now - start > timeoutMs)
      throw new Error(`frame never matched after ${JSON.stringify(key)}:\n${frame}`)
    if (now - lastWrite >= retryMs && frame === before) {
      stdin.write(key)
      lastWrite = now
    }
    await Bun.sleep(15)
  }
}

/**
 * Wait until the chat input is on screen, then a moment more: Ink attaches `useInput` in an effect,
 * so keys written the instant the input first renders can be dropped (the chat mounts after
 * `auth.whoami` answered).
 */
export async function chatReady(lastFrame: () => string | undefined): Promise<void> {
  await frameUntil(lastFrame, (f) => f.includes('type a message'))
  await Bun.sleep(150)
}

/** Press `pgdn` (a long screen such as Help) until the frame passes `check`. */
export async function scrollUntil(
  stdin: { write(data: string): void },
  lastFrame: () => string | undefined,
  check: (frame: string) => boolean,
  steps = 12,
): Promise<string> {
  for (let i = 0; i < steps && !check(lastFrame() ?? ''); i++) {
    stdin.write('\u001b[6~')
    await Bun.sleep(80)
  }
  return frameUntil(lastFrame, check)
}

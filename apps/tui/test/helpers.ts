import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/** A temp `XDG_CONFIG_HOME`, removed by the returned cleanup. */
export async function tempConfigHome(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'keith-tui-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

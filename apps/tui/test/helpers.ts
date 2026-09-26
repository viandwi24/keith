import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A temp `XDG_CONFIG_HOME`, removed by the returned cleanup. */
export async function tempConfigHome(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'keith-tui-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

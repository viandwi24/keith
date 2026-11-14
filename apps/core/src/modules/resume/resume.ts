import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessAgent, SessionLock } from 'eharness'
import { uuidv7 } from 'eharness'
import { frontSessionOptions } from '../../platform/sessions.ts'

/** How long a finished stream log stays readable (a reader may join late). */
export const STREAM_RETENTION_MS = 600_000

/**
 * The stable id of this core: random once, kept in `<dataDir>/instance-id`. A restarted core with
 * the same id recovers the turn it left unfinished at once, instead of after `staleMs`.
 */
export function instanceIdOf(dataDir: string): string {
  const file = join(dataDir, 'instance-id')
  if (existsSync(file)) {
    const id = readFileSync(file, 'utf8').trim()
    if (id !== '') return id
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const id = `core-${uuidv7()}`
  writeFileSync(file, `${id}\n`, { mode: 0o600 })
  return id
}

/** Agent options that make a turn resumable: a stable instance id and the stream log retention. */
export const resumeConfig = (instanceId: string) =>
  ({
    recovery: { instanceId },
    streams: { retentionMs: STREAM_RETENTION_MS },
  }) as const

/**
 * Boot step: repair the turn a dead process left in a session (marks it interrupted, saves the
 * notice). Never throws: a failure is reported and boot goes on.
 */
export async function recoverSession(
  agent: HarnessAgent,
  sessionId: string,
  lock: SessionLock,
  log: { info(message: string): void; warn(message: string): void },
): Promise<void> {
  try {
    const result = await agent.session(sessionId, frontSessionOptions(sessionId, lock)).recover()
    if (result.recovered) log.info(`recovered the unfinished turn of ${sessionId}`)
  } catch (error) {
    log.warn(`recover failed for ${sessionId}: ${error instanceof Error ? error.message : error}`)
  }
}

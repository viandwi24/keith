import type { effectiveNetwork } from '../../modules/admin/index.ts'
import type { Config } from '../../platform/config.ts'
import type { CliDeps } from '../context.ts'

export type Level = 'ok' | 'warn' | 'fail'
export interface Check {
  level: Level
  name: string
  hint: string
}
export const MARK: Record<Level, string> = { ok: '✓', warn: '!', fail: '✗' }

export const formatCheck = (c: Check): string => `${MARK[c.level]} ${c.name} — ${c.hint}`

/** The exit code of `doctor`: 1 when any check failed, warnings and notes never fail it. */
export const exitCodeOf = (checks: readonly Check[]): 0 | 1 =>
  checks.some((c) => c.level === 'fail') ? 1 : 0

/** What a check reads: the CLI deps, the config, the flag and the results so far. `net` is set by the setup check. */
export interface DoctorCtx {
  deps: CliDeps
  config: Config
  offline: boolean
  checks: readonly Check[]
  net: ReturnType<typeof effectiveNetwork>
}

/** One entry of the table in `../doctor.ts`: returns the lines it adds, in order. */
export type DoctorCheck = (ctx: DoctorCtx) => Check[] | Promise<Check[]>

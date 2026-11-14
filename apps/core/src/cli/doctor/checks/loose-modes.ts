import { existsSync, statSync } from 'node:fs'
import { ownedPaths } from '../../../platform/db.ts'
import type { Check, DoctorCheck } from '../types.ts'

const mode = (path: string): number => statSync(path).mode & 0o777

/**
 * The entries Keith owns (`OWNED_ENTRIES`, FD11-02) that are readable by anyone but the owner. The same list the
 * core sets at every start, so `doctor` never walks `workspace/` or `memory/`.
 */
export function looseModes(dir: string): string[] {
  return ownedPaths(dir)
    .filter(({ path }) => mode(path) & 0o077)
    .map(({ path }) => path)
}

/** The data folder exists and nothing in it is open to others. */
export const dataDirCheck: DoctorCheck = ({ config }) => {
  if (!existsSync(config.dataDir)) {
    return [
      {
        level: 'fail',
        name: 'data dir',
        hint: `${config.dataDir} does not exist: run keith-core setup`,
      },
    ]
  }
  const bad = looseModes(config.dataDir)
  const check: Check =
    bad.length === 0
      ? { level: 'ok', name: 'data dir', hint: `${config.dataDir} (0700, files 0600)` }
      : {
          level: 'fail',
          name: 'data dir',
          hint: `${bad.length} path(s) open to others (${bad[0]}): chmod go-rwx or run keith-core start`,
        }
  return [check]
}

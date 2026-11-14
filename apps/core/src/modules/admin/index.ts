// Admin: the owner's configuration channel (docs/specs/core-cli.md): the offline service layer,
// its lock file, effective network settings, and the `admin.*` procedures.
export { acquireLock, type FileLock, LockHeldError } from './lockfile.ts'
export {
  configEntries,
  deriveBindHost,
  effectiveNetwork,
  isLoopback,
  type Network,
  SETTING,
  type ValueSource,
} from './network.ts'
export {
  LOCK_FILE,
  type OfflineAdmin,
  type OfflineOptions,
  openOfflineAdmin,
  withOfflineAdmin,
} from './offline.ts'
export { type AdminProceduresOptions, adminProcedures } from './procedures.ts'
export { isSetUp, ownerName } from './setup-state.ts'

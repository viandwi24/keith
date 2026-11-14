// People: the directory of who uses Keith, their roles and status (docs/specs/people.md).
export { type AliasesService, createAliasesService } from './aliases.ts'
export {
  createPersonExport,
  type PersonExported,
  type PersonExporter,
  type PersonExportOptions,
  type PersonExportTarget,
} from './export.ts'
export { createGrantsService, type GrantsService } from './grants.ts'
export {
  createPeopleService,
  type PeopleCaller,
  PeopleError,
  type PeopleOptions,
  type PeopleService,
  type RemovedPerson,
  toPerson,
} from './people.ts'
export { peopleProcedures, selfPinProcedures } from './procedures.ts'
export {
  CORE_TABLES,
  type CoreRemovalOptions,
  coreRemoval,
  personParts,
} from './removal-core.ts'
export {
  createRemovalRegistry,
  type PersonRemovalHooks,
  type RemovalRegistry,
  type RemovalUndo,
} from './removal-registry.ts'
export {
  createRemoval,
  REMOVED_KEEP_MS,
  type RemovalService,
  type RemovedManifest,
  readRemovedManifest,
  removedFolderOf,
  removedRootOf,
} from './removed.ts'
export { createSecretsService, type SecretsService, type SecretsServiceOptions } from './secrets.ts'
// minted only by the succession module (a test pins the importers); no RPC or CLI path takes it
export { mintSuccessionProof, type SuccessionProof } from './succession-proof.ts'

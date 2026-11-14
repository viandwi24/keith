// Public API of @keith/acl: the evaluator, the ports and the in-memory store (docs/specs/acl.md).
export { aclActorOf } from './actor.ts'
export { type CheckInput, check, type ResourceAccess } from './check.ts'
export { AclError, type AclErrorCode } from './errors.ts'
export {
  DEFAULT_MODE_BY_CLASS,
  defaultModeOf,
  defineKinds,
  entryProblem,
  type KindDef,
  type KindRegistry,
  modeProblem,
  resourceProblem,
} from './kinds.ts'
export type { Membership } from './membership.ts'
export { type MemoryAcl, type MemoryAclOptions, memoryAcl } from './memory.ts'
export { type AclStore, type GroupInput, type ResourceInput, requireAccess } from './store.ts'

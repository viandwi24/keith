// Conformance data for every ACL store (`@keith/acl/testing`).
export {
  CASE_ACTOR_NAMES,
  CASE_ACTORS,
  CASE_GROUPS,
  CASE_KINDS,
  CASE_PEOPLE,
  type CaseActorName,
  SHARING_CASES,
  type SharingCase,
} from './cases.ts'
export {
  assertNoLeak,
  type LeakActors,
  type LeakCheckOptions,
  type LeakOperations,
  type LeakReport,
  type LeakSeed,
  type LeakTarget,
  leakCheck,
} from './leak.ts'

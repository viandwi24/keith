// The testing kit of the host (`@keith/host/testing`, docs/specs/plugins.md): fakes and the in-memory host.

// The conformance kit of the ACL, re-exported so a plugin's tests import only the host (`plugins-only-host-contracts`).
export {
  assertNoLeak,
  CASE_ACTOR_NAMES,
  CASE_ACTORS,
  CASE_GROUPS,
  CASE_KINDS,
  CASE_PEOPLE,
  type CaseActorName,
  type LeakActors,
  type LeakCheckOptions,
  type LeakOperations,
  type LeakReport,
  type LeakSeed,
  type LeakTarget,
  leakCheck,
  SHARING_CASES,
  type SharingCase,
} from '@keith/acl/testing'
export { echoPlugin } from './echo.ts'
export {
  type FakeClock,
  fakeActor,
  fakeClock,
  fakeGuest,
  frontSession,
  type RecordingAudit,
  recordingAudit,
} from './fakes.ts'
export { HOSTILE_BYTES, hostilePlugin } from './hostile-view.tsx'
export { type MemoryHost, memoryHost } from './memory-host.ts'
export { alphaPlugin, betaTwoPlugin, FIXTURES_DIR } from './storage-fixtures.ts'
export { type OpenTestViewOptions, openTestView, type TestView } from './view-driver.ts'

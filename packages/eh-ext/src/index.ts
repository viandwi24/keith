// Public API of @keith/eh-ext: Keith-only glue on top of eharness. The eharness adapters Keith owns (stream log, inbox,
// activity store, person store, budget ledger) live in packages/db/src/eh; see AGENTS.md here.
export {
  declaresSource,
  EHARNESS_TOOL_TRAITS,
  effectOfRisk,
  eharnessConsentRisk,
  toolEffect,
  toolReversible,
  toolSelfConfirmed,
  toolSource,
} from './tool-source.ts'

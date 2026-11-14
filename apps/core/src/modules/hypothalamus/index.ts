// The hypothalamus region: protocols and the personal agenda (docs/specs/hypothalamus.md). Other modules import only
// this file (module-public-api rule); the internals stay private.

export { type ActPorts, createAct, type PluginCaller } from './act.ts'
export {
  type AgendaAdded,
  type AgendaService,
  type AgendaServiceDeps,
  type AgendaSource,
  agendaOverlay,
  createAgendaService,
} from './agenda.ts'
export {
  type ActApproval,
  type AuthorCaller,
  type AuthorCaps,
  type AuthorInput,
  type AuthorRefusal,
  type AuthorRefusalReason,
  type AuthorResult,
  actApprovalHash,
  authorDefinition,
  canonicalJson,
  KEITH_OWNER,
  PERSON_MAX_BUDGET_USD_PER_RUN,
  PERSON_MAX_RUNS_PER_DAY,
} from './authoring.ts'
export {
  APPROVAL_STALE,
  BUILT_IN_DEFINITIONS,
  type BuiltInName,
  REMINDER_MISSED,
  seedBuiltIns,
} from './builtins.ts'
export { isEnabledWanted, syncOwnerAbsence } from './builtins-succession.ts'
export {
  createProtocolCatalog,
  type ProtocolCatalogDeps,
  type ProtocolCatalogHandle,
} from './catalog.ts'
export {
  type ConditionEnv,
  type ConditionPorts,
  evaluateCondition,
  inWindow,
  minutesOfDay,
  pendingApproval,
} from './conditions.ts'
export {
  outcomeOfDelivery,
  type PersonActivity,
  type ProtocolDelivery,
} from './deliver-port.ts'
export {
  DREAM,
  DREAM_CRON,
  dreamDefinition,
  dreamSettingsOf,
  effectiveDreamMode,
  syncDream,
} from './dream-protocol.ts'
export {
  createDreamSteps,
  DREAMING_RUN,
  type DreamingRunPort,
  dreamingRunOutcome,
  FEW_MESSAGES_MIN,
} from './dream-steps.ts'
export type { AnswerInput, AnswerOutcome } from './drive.ts'
export {
  createEngine,
  createRunStarter,
  DEFAULT_TICK_LIMIT,
  type ProtocolEngine,
  type RecoverReport,
  type StartInput,
  type StartOutcome,
  type TickOutcome,
} from './engine.ts'
export {
  createProtocolHostPort,
  type DelegatingProtocolsPort,
  delegatingProtocolsPort,
  hostNameOf,
  type ProtocolHostPort,
  type ProtocolHostPortDeps,
} from './host-port.ts'
export { createJournal, type JournalDeps } from './journal.ts'
export type {
  EngineDeps,
  FlatDetail,
  Journal,
  RunAuditKind,
  RunEventType,
  StepDetail,
  StepResult,
  StepRunInput,
  StepRunner,
} from './ports.ts'
export { agendaProcedures, protocolProcedures } from './procedures.ts'
export {
  createProposalService,
  PROPOSAL_TTL_MS,
  type ProposalInput,
  type ProposalService,
  type ProposalSource,
} from './proposals.ts'
export {
  HYPOTHALAMUS_FILE,
  type HypothalamusRemovalOptions,
  hypothalamusRemoval,
} from './removal.ts'
export {
  createProtocolService,
  type ProtocolCaller,
  type ProtocolService,
  type ProtocolServiceDeps,
} from './service.ts'
export {
  createProtocolSettings,
  PROTOCOL_SETTING_KEYS,
  type ProtocolSettingsReader,
} from './settings.ts'
export { createSignOfLife, type SignOfLife } from './sign-of-life.ts'
export {
  BUDGET_NOTICE,
  createStepRunner,
  runIdFor,
  type StepRunnerDeps,
  WAKE_COST_USD,
} from './steps.ts'
export {
  createSuccession,
  type SuccessionService,
  type SuccessionSettings,
} from './succession.ts'
export { type SuccessionProcedures, successionProcedures } from './succession-procedures.ts'
export {
  OWNER_ABSENCE,
  type SuccessionCaller,
  type SuccessionDeps,
  SuccessionError,
  type SuccessionPeople,
} from './succession-shared.ts'
export { createSuccessionSteps } from './succession-steps.ts'
export {
  PROTOCOL_TOOL_PLUGIN,
  type ProtocolToolPorts,
  type ProtocolToolSlot,
  protocolToolSlot,
  protocolToolsOf,
} from './tools.ts'
export {
  type ActiveProtocol,
  type CursorStore,
  createTriggers,
  type FeedPort,
  type FeedRecord,
  type LastSignPort,
  nextCronSlot,
  type ProtocolCatalog,
  protocolScope,
  type RunStarter,
  type RunStartInput,
  type RunStartOutcome,
  type SignalCursor,
  type SignalRow,
  type SignalsPort,
  settingsCursorStore,
  TRIGGER_CURSOR_KEY,
  type TriggerCursor,
  type TriggerDetail,
  type Triggers,
  type TriggerTickReport,
  timeScheduleId,
} from './triggers.ts'
export { ProtocolError, type ProtocolErrorCode } from './views.ts'
export { UNKNOWN_NOTICE } from './writer.ts'

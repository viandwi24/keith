// Public API of @keith/host: define a plugin, guard its operations, test it (docs/specs/plugins.md).

export type {
  AccessCaller,
  AccessPort,
  AclWriteAudit,
  AclWriteCaller,
  OwnerAccessPort,
  PeoplePort,
  PersonRef,
  PluginAccess,
  PluginPeople,
} from './access.ts'
export { readContributions } from './contributions.ts'
export { buildCtx, MAX_CALL_DEPTH } from './ctx.ts'
export { defineKeithPlugin, defineOperation, PluginDefinitionError } from './define.ts'
export {
  GUARD_STATUS,
  type GuardCode,
  GuardError,
  NOT_FOUND_MESSAGE,
  OperationError,
} from './errors.ts'
export {
  EVENT_DATA_MAX,
  EVENT_RECIPIENTS_MAX,
  type EventTo,
  NOTICE_MAX,
  type Publisher,
} from './events.ts'
export {
  type ActorDirectory,
  type ActorFacts,
  createGuard,
  type Guard,
  type GuardCall,
  type GuardDeps,
} from './guard.ts'
export {
  harnessNameOf,
  OPERATION_NAME,
  PLUGIN_ID,
  RESERVED_PLUGIN_IDS,
  routeOf,
  toolNameOf,
} from './ids.ts'
export { buildOpenApi, type JsonObject, type OpenApiOptions } from './openapi.ts'
export {
  checkProtocolTime,
  type PluginProtocolStep,
  type PluginProtocols,
  PROTOCOL_NOTIFY_TEXT_MAX,
  PROTOCOL_WAKE_TEXT_MAX,
  type ProtocolCaller,
  type ProtocolRunEnd,
  type ProtocolsPort,
  type ProtocolTimeInfo,
  type ProtocolTimeInput,
} from './protocols.ts'
export {
  MIN_CRON_GAP_MS,
  type PersonFacts,
  type PluginSchedule,
  SCHEDULE_KEY,
  SCHEDULE_PAYLOAD_MAX,
  type ScheduleCatchUp,
  type ScheduleFire,
  type ScheduleFireCtx,
  type ScheduleInfo,
  type ScheduleInput,
  type ScheduleOutcome,
  type SchedulePort,
  type ScheduleWhen,
  type WakePort,
  type WakeRequest,
  type WakeResult,
} from './schedule.ts'
export {
  type BootPlan,
  createServiceRegistry,
  type PlanBootOptions,
  planBoot,
  type ServiceRegistry,
} from './services.ts'
export {
  type Audience,
  type AuditEvent,
  type AuditPort,
  type Clock,
  type Contribution,
  type ContributionEntry,
  type EventAudience,
  type EventPort,
  type Exposure,
  isReviewTicket,
  type KeithCtx,
  type KeithPlugin,
  type NotifyPort,
  type OperationDef,
  type OperationRisk,
  type PermissionDecl,
  PLUGIN_API_VERSION,
  type PluginDb,
  type PluginEvent,
  type PluginKv,
  type PluginManifest,
  type PluginPermission,
  type PluginServices,
  type PluginStartCtx,
  type PluginStorage,
  type RateLimit,
  type ResolvedOperation,
  type ResourceRule,
  type ReviewPort,
  type ReviewRule,
  type ReviewTicket,
  type SessionFacts,
  type Stop,
  type Surface,
  type TuiSlot,
} from './types.ts'

// Public API of @keith/db: the database, its migrations and the eharness storage adapters.
// Only apps/core imports this package.

export {
  type ActivityBodies,
  type ActivityBodiesInput,
  type ActivityCallInput,
  type ActivityLogsRepo,
  type ActivityLogsStatus,
  type ActivitySessionFilter,
  type ActivitySessionInput,
  type ActivitySessionPage,
  activityLogsRepo,
} from './activity-logs-repo.ts'
export {
  assertMigrated,
  type JournalState,
  journalStateOf,
  MIGRATIONS_DIR,
  migrateDatabase,
  newerKeithMessage,
  openDatabase,
} from './connection.ts'
export { sqliteActivityStore } from './eh/activity-store.ts'
export {
  type BudgetScopeStatus,
  budgetStatus,
  currentPeriod,
  setBudgetLimit,
  sqliteBudgetLedger,
} from './eh/budget-ledger.ts'
export { sqliteCatalogCache } from './eh/catalog-cache.ts'
export { sqliteInbox } from './eh/inbox.ts'
export { type SqliteLockOptions, sqliteLock } from './eh/lock.ts'
export { sqliteMessages, sqliteState } from './eh/messages.ts'
export {
  DEFAULT_PERSON_ROLE,
  type KeithPerson,
  type KeithPersonInput,
  type KeithPersonPatch,
  type KeithPersonStore,
  type PersonRole,
  sqlitePersonStore,
} from './eh/person-store.ts'
export { sqliteProfileStore } from './eh/profile-store.ts'
export { sqliteSchedules } from './eh/schedules.ts'
export type { Sqlite } from './eh/sql.ts'
export { type SqliteStreamLogOptions, sqliteStreamLog } from './eh/stream-log.ts'
export {
  type FilterOptions,
  type SqlFragment,
  type SqliteAcl,
  type SqliteAclOptions,
  sqliteAcl,
} from './repos/acl.ts'
export {
  AGENDA_DEFAULT_SPAN_MS,
  type AgendaItemPatch,
  type AgendaItemRecord,
  type AgendaItemStatus,
  type AgendaRepo,
  agendaRepo,
  type NewAgendaItem,
} from './repos/agenda.ts'
export {
  AUDIT_SCAN_LIMIT,
  type AuditEventInput,
  type AuditEventRecord,
  type AuditPage,
  type AuditRepo,
  type AuditVia,
  auditRepo,
} from './repos/audit.ts'
export {
  type ClientRegisterResult,
  type ClientRow,
  type ClientsRepo,
  clientsRepo,
} from './repos/clients.ts'
export {
  type CredentialKind,
  type CredentialLookup,
  type CredentialRecord,
  type CredentialsRepo,
  credentialsRepo,
} from './repos/credentials.ts'
export {
  type DeliveriesRepo,
  type DeliveryPatch,
  type DeliveryRecord,
  type DeliveryStatus,
  deliveriesRepo,
  type NewDelivery,
} from './repos/deliveries.ts'
export {
  type DeviceCreateResult,
  type DeviceRequestLookup,
  type DeviceRequestRecord,
  type DeviceRequestStatus,
  type DeviceRequestsRepo,
  deviceRequestsRepo,
  MAX_PENDING_PER_IP,
} from './repos/devices.ts'
export {
  DREAM_ROW_STATUSES,
  type DreamCursor,
  type DreamingRepo,
  type DreamingRepoOptions,
  type DreamRowStatus,
  type DreamRunEnd,
  type DreamRunRecord,
  dreamingRepo,
  type NewDreamRun,
} from './repos/dreaming.ts'
export {
  type FrontGenerationRecord,
  type FrontGenerationsRepo,
  frontGenerationsRepo,
} from './repos/front-generations.ts'
export { type GrantsRepo, grantsRepo } from './repos/grants.ts'
export {
  type IdentifierCandidates,
  type IdentifierKind,
  type IdentifierRecord,
  type IdentifiersRepo,
  identifiersRepo,
  type LoginPerson,
} from './repos/identifiers.ts'
export {
  type JoinResult,
  type NodeInput,
  type NodeManifestUpdate,
  type NodeRecord,
  type NodeStatus,
  type NodesRepo,
  nodesRepo,
} from './repos/nodes.ts'
export {
  type CodeProblem,
  MAX_ACTIVE_PAIRING_CODES,
  type PairingConsumeResult,
  type PairingCreateResult,
  type PairingRepo,
  pairingRepo,
} from './repos/pairing.ts'
export { backfillPeople } from './repos/people-backfill.ts'
export {
  PERSONA_ID,
  type PersonaRecord,
  type PersonaRepo,
  type PersonaVersionRecord,
  type PersonaWriteInput,
  personaRepo,
} from './repos/persona.ts'
export {
  type PersonStyleRecord,
  type PersonStyleRepo,
  personStyleRepo,
} from './repos/persona-style.ts'
export {
  type DisclosureEntry,
  type PresenceDisclosureRepo,
  presenceDisclosureRepo,
} from './repos/presence-disclosure.ts'
export {
  ACTIVE_COALESCE_MS,
  type PresenceSignalsRepo,
  presenceSignalsRepo,
  SIGNAL_DETAIL_MAX_BYTES,
  type SignalInput,
  type SignalRecord,
} from './repos/presence-signals.ts'
export {
  type PresenceStatusRepo,
  presenceStatusRepo,
  type StatusKind,
  type StatusRow,
} from './repos/presence-status.ts'
export {
  type NewRun,
  type NewRunStep,
  type ProtocolRunsRepo,
  protocolRunsRepo,
  type RunPatch,
  type RunRecord,
  type RunStepRecord,
  type StartRunResult,
} from './repos/protocol-runs.ts'
export {
  type CreateProtocolResult,
  type NewProposal,
  type NewProtocol,
  type ProposalStatus,
  type ProtocolProposalRecord,
  type ProtocolProposalsRepo,
  type ProtocolRecord,
  type ProtocolsRepo,
  protocolProposalsRepo,
  protocolsRepo,
  type RunStatus,
  type SaveVersionResult,
  type VersionRecord,
} from './repos/protocols.ts'
export {
  type NewPushSubscription,
  type PushSubscriptionRow,
  type PushSubscriptionsRepo,
  pushSubscriptionsRepo,
} from './repos/push-subscriptions.ts'
export { type RetentionRepo, retentionRepo } from './repos/retention.ts'
export {
  type ReviewCreateResult,
  type ReviewRecord,
  type ReviewStatus,
  type ReviewsRepo,
  reviewsRepo,
} from './repos/reviews.ts'
export {
  ANSWER_MODES,
  type AnswerMode,
  type CreateRoomResult,
  type DecideResult,
  type EndResult,
  EVENT_KINDS,
  type EventData,
  type EventKind,
  type EventRecord,
  type InviteResult,
  MEMBER_STATUSES,
  type MemberRecord,
  type MemberStatus,
  type MoveResult,
  type NewEvent,
  type NewRequest,
  type NewRoom,
  REQUEST_KINDS,
  REQUEST_STATUSES,
  REQUEST_TTL_MS,
  type RequestKind,
  type RequestRecord,
  type RequestStatus,
  ROOM_STATES,
  ROOM_TEXT_MAX,
  type RoomRecord,
  type RoomState,
  type RoomsRepo,
  roomsRepo,
} from './repos/rooms.ts'
export {
  ANY_IP,
  type AttemptRecord,
  type SecretKind,
  type SecretsRepo,
  secretsRepo,
} from './repos/secrets.ts'
export { type SettingsRepo, settingsRepo } from './repos/settings.ts'
export {
  SUCCESSION_STATES,
  type SuccessionFields,
  type SuccessionRecord,
  type SuccessionRepo,
  type SuccessionStart,
  type SuccessionStateName,
  successionRepo,
} from './repos/succession.ts'
export {
  type TaskInput,
  type TaskListQuery,
  type TaskRecord,
  type TaskStatus,
  type TasksRepo,
  tasksRepo,
} from './repos/tasks.ts'
export {
  type Person,
  type PersonStatus,
  type TokenRecord,
  type TokenRow,
  type TokensRepo,
  tokensRepo,
} from './repos/tokens.ts'
export { type WorkspaceRow, type WorkspacesRepo, workspacesRepo } from './repos/workspaces.ts'

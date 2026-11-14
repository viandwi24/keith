// Public API of @keith/client: the typed client every Keith UI uses.
// The eharness stop-reason and notice-code constants, for UIs that may not import the eharness root.
export { type KnownStopReason, NOTICE_CODES, type NoticeCode, STOP_REASONS } from 'eharness/codes'
export {
  type LogsApi,
  type LogsCallInput,
  type LogsRawInput,
  type LogsSessionInput,
  type LogsSessionOutput,
  logsApiOf,
} from './activity-logs.ts'
export {
  type ChatContextApi,
  type ChatContextApiOptions,
  ChatContextDeadlineError,
  type ChatContextFeed,
  CONTEXT_DEADLINE_MS,
  chatContextApiOf,
  chatContextRefusalOf,
  watchChatContext,
  watchChatContextPending,
} from './chat-context.ts'
export {
  type AttentionItem,
  brainEventOf,
  CHAT_CLIP,
  createKeithClient,
  frontSessionOf,
  KEITH_ATTENTION_EVENTS,
  type KeithAttention,
  type KeithClient,
  type KeithClientOptions,
  pluginEventOf,
} from './client.ts'
export {
  type ClientConfig,
  DEFAULT_CORE,
  defaultConfigPath,
  isRemembered,
  readClientConfig,
  removeSocketSession,
  writeClientConfig,
} from './config.ts'
export {
  type ConnectionMonitor,
  type ConnectionMonitorOptions,
  createConnectionMonitor,
  type LinkFeedStatus,
  type LinkKind,
  type LinkState,
  type MonitorClock,
  RETRY_NOW_GAP_MS,
} from './connection-monitor.ts'
export { reasonOf, type WatchOptions, watchConnection } from './connection-watch.ts'
export {
  type DreamingApi,
  dreamingApiOf,
  dreamRefusalOf,
} from './dreaming.ts'
export {
  defaultProbes,
  detectEnvironment,
  deviceOf,
  type EnvironmentProbes,
  hostOf,
  osOf,
} from './environment.ts'
export {
  createGuestClient,
  GUEST_END_TEXT,
  GUEST_FAILURE_OF_CODE,
  type GuestChatEvent,
  type GuestClient,
  type GuestClientOptions,
  GuestError,
  type GuestFailureKind,
  type GuestSessionView,
  guestFailureText,
} from './guest.ts'
export { clientStatePath, fileClientIdStore, fileIdentifierMemory } from './identifier-memory.ts'
export {
  isLockedError,
  LocalLockError,
  type LocalLockFailure,
  type LocalSecret,
  localStatus,
  lockLocal,
  openLocalSession,
  setFirstOwner,
  unlockLocal,
} from './local-lock.ts'
export {
  DEVICE_POLL_MS,
  DeviceLoginError,
  type DeviceLoginFailure,
  type DeviceLoginOptions,
  deviceLogin,
} from './login.ts'
export {
  KEITH_STEP_UP_REQUIRED,
  LoginError,
  type LoginFailure,
  type PasswordLoginOptions,
  passwordLogin,
  StepUpError,
  type StepUpFailure,
  type StepUpOptions,
  stepUp,
} from './password.ts'
export { type PersonaApi, type PersonaFeed, personaApiOf, watchPersona } from './persona.ts'
export {
  type ClientDelivery,
  type ClientIdStore,
  createPresenceReporter,
  type DeliveryHandler,
  type NotifyHandler,
  type PresenceReporter,
  type PresenceReporterOptions,
  TERMINAL_CAPABILITIES,
  UNSUPPORTED,
  UnsupportedDelivery,
} from './presence.ts'
export {
  createRoomEvents,
  createRoomView,
  ROOM_EVENTS_PAGE,
  type RoomEvents,
  type RoomEventsFeed,
  type RoomEventsOptions,
  type RoomEventsState,
  type RoomFeedRecord,
  type RoomsApi,
  type RoomViewOptions,
  type RoomViewSnapshot,
  type RoomViewStore,
  roomsApiOf,
} from './rooms.ts'
export {
  createSignIn,
  type IdentifierMemory,
  type ParsedAddress,
  parseSignInAddress,
  type SignIn,
  type SignInCoreInfo,
  type SignInFailure,
  type SignInMethod,
  type SignInMethodItem,
  type SignInOptions,
  type SignInPerson,
  type SignInProblem,
  type SignInState,
  type SignInStore,
} from './sign-in.ts'
export { localSocketPath, probeSocket, socketFetch } from './socket.ts'
export {
  fetchViewMenu,
  ViewMenuError,
  type ViewMenuFailure,
} from './view/menu.ts'
export {
  type OpenViewOptions,
  openView,
  PASTE_MAX,
  type ViewConnection,
  type ViewConnector,
  type ViewEndReason,
  type ViewSocket,
  type ViewStatus,
} from './view/open-view.ts'
export {
  MARK_CHAIN_MAX,
  PARSE_INPUT_MAX,
  type ParsedFrame,
  type ParseOptions,
  parseFrame,
  SEQUENCE_MAX,
  type ViewLine,
  type ViewRun,
} from './view/parse-frame.ts'

// Browser entry of @keith/client (`@keith/client/browser`): the same typed client without a Node or Bun API, directly or
// transitively (browser.test.ts walks the import graph and fails on one). The session is an HttpOnly cookie, so
// `createKeithClient` takes `auth: 'cookie'` and no token. What is not here is Node-only: the stored login file (config.ts),
// host detection (environment.ts), the identifier file (identifier-memory.ts), the local socket and lock (socket.ts,
// local-lock.ts) and the file-backed defaults of `createSignIn` and `createPresenceReporter`.
export {
  type ActivityFeed,
  type AnswerResponse,
  type AttentionList,
  type ChatSession,
  type ChatSessionState,
  describeChatError,
  type HarnessClient,
  HarnessHttpError,
  isClippedPart,
  isHarnessHttpError,
  isNetworkError,
  type ResyncReason,
} from 'eharness/client'
export { type KnownStopReason, NOTICE_CODES, type NoticeCode, STOP_REASONS } from 'eharness/codes'
export {
  type LogsApi,
  type LogsCallInput,
  type LogsRawInput,
  type LogsSessionInput,
  type LogsSessionOutput,
  logsApiOf,
} from './activity-logs.ts'
export { type BrowserClientOptions, createKeithClient } from './browser/client.ts'
export {
  browserNameOf,
  browserOsOf,
  detectBrowserEnvironment,
  type NavigatorLike,
  WEB_CAPABILITIES,
} from './browser/environment.ts'
export {
  adoptToken,
  type CookieSignInOptions,
  createCookieSignIn,
  logout,
  type SessionCallOptions,
} from './browser/session.ts'
export {
  localStorageClientIdStore,
  localStorageIdentifierMemory,
  type StorageLike,
} from './browser/storage.ts'
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
  frontSessionOf,
  KEITH_ATTENTION_EVENTS,
  type KeithAttention,
  type KeithClient,
  pluginEventOf,
} from './client.ts'
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
export { type DreamingApi, dreamingApiOf, dreamRefusalOf } from './dreaming.ts'
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
export {
  DEVICE_POLL_MS,
  DeviceLoginError,
  type DeviceLoginFailure,
  type DeviceLoginOptions,
  type DeviceLoginResult,
  deviceLogin,
  deviceLoginResult,
} from './login.ts'
export {
  KEITH_STEP_UP_REQUIRED,
  LoginError,
  type LoginFailure,
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
  memoryClientIdStore,
  type NotifyHandler,
  type PresenceReporter,
  type PresenceReporterOptions,
  UNSUPPORTED,
  UnsupportedDelivery,
} from './presence.ts'
export {
  applicationServerKeyOf,
  listPush,
  type PushSubscriptionLike,
  pushPublicKey,
  type SubscribePushOptions,
  subscribePush,
  unsubscribePush,
} from './push.ts'
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
export { isHome, isLeave, type KeyLike, keyBytes } from './view/key-bytes.ts'
export { fetchViewMenu, ViewMenuError, type ViewMenuFailure } from './view/menu.ts'
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
export { adoptSession, endWebSession, WebSessionError } from './web-session.ts'

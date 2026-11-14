// Corpus callosum: shared rooms (docs/specs/corpus-callosum.md). Other modules import only this file. The service, the ACL,
// the text transport, the settings, the removal part, the procedures, the room agent and the turn pipeline exist.
export {
  createRoomAcl,
  ROOM_KIND,
  ROOM_KIND_DEF,
  type RoomAcl,
  type RoomAclOptions,
  type TranscriptReader,
} from './acl.ts'
export {
  createRoomAgent,
  type RoomAgentOptions,
} from './agent.ts'
export { createRoomContext, type RoomContextDeps, type WorkspaceEntry } from './context.ts'
export {
  createRoomHandoff,
  createRoomTurnSeqs,
  HANDOFF_LINE,
  HANDOFF_REPLY,
  HANDOFF_REQUEST_MAX,
  type RoomHandoff,
  type RoomTurnSeqs,
} from './handoff.ts'
export type {
  Audit,
  Delivery,
  PeopleService,
  RoomDelivery,
  RoomPeople,
  RoomPresence,
} from './ports.ts'
export { createRoomPostPlugin, ROOM_POST_TOOL, type RoomPostDeps, roomPostToolOf } from './post.ts'
export { type RoomProcedureDeps, roomProcedures } from './procedures.ts'
export {
  ROOMS_FILE,
  type RoomsRemovalOptions,
  roomsOnIdentityChanged,
  roomsRemoval,
} from './removal.ts'
export {
  createRoomService,
  type EndedMembership,
  type InviteOutcome,
  ROOM_START_CAPABILITY,
  type RoomActivity,
  type RoomCaller,
  type RoomCapabilities,
  RoomError,
  type RoomErrorCode,
  type RoomFeed,
  type RoomRefusal,
  type RoomService,
  type RoomServiceOptions,
  type RoomStarted,
  roomSessionId,
  type SweepResult,
  SYSTEM_CALLER,
} from './service.ts'
export {
  createRoomSettings,
  ROOM_SETTING_KEYS,
  type RoomSettingsReader,
} from './settings.ts'
export { type RoomToolCall, type RoomToolDeps, roomTools } from './tools.ts'
export {
  createRoomFeed,
  createTextTransport,
  type RoomFeedNotice,
  type TextRoomTransport,
} from './transport-text.ts'
export {
  addressedOf,
  createRoomTurns,
  type RoomTurns,
  type RoomTurnsOptions,
  type TurnItem,
} from './turns.ts'
export {
  createRoomWorkspace,
  isRoomWorkspaceSealed,
  listRoomFiles,
  roomWorkspaceDir,
  sealRoomWorkspace,
} from './workspace.ts'

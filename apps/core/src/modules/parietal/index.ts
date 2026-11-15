// The parietal region: clients and presence of each person (docs/specs/parietal.md). These are the only entry points
// other regions may use; nobody reaches into the computation.
export {
  CLIENT_CAPABILITIES,
  CLIENT_CAPABILITY_IDS,
  type ClientCapabilityId,
  type ClientCapabilitySpec,
  deliveryInput,
  isClientCapabilityId,
} from './capabilities.ts'
export {
  CLIENT_ACK_MS,
  type ClientCall,
  type ClientRoutePort,
  type ClientTarget,
  createClientRoute,
} from './client-route.ts'
export {
  appsOnlineLine,
  CLIENT_CALL_DESCRIPTION,
  CLIENT_CALL_TOOL,
  type ClientCallResult,
  type ClientCallToolOptions,
  clientCallTool,
  clientCallToolOf,
  clientsFor,
} from './client-tools.ts'
export {
  computePresence,
  DEFAULT_WINDOWS,
  type OutStatus,
  type PresenceWindows,
  whereOf,
} from './compute.ts'
export {
  activeClientOf,
  CLIENT_CONTEXT_HEADING,
  type ClientContextFacts,
  clientContextBlock,
  clientContextFor,
  localClockOf,
  WHERE_HINT,
} from './context-block.ts'
export {
  createDisclosure,
  DEFAULT_GROUP_LEVEL,
  DEFAULT_OWNER_LEVEL,
  DEFAULT_USERS_LEVEL,
  type Disclosure,
  type DisclosureDeps,
  groupAudience,
  OWNER_AUDIENCE,
  USERS_AUDIENCE,
} from './disclose.ts'
export { type ConnectionFacts, clientNetworkOf, type NetworkRules } from './network.ts'
export { createOverlayRegistry, type OverlayRegistry, type PresenceOverlay } from './overlay.ts'
export { createPresencePlanner, type PresencePlannerDeps } from './planner.ts'
export {
  createParietalPorts,
  type DisclosedLine,
  LAST_SIGN_TYPES,
  type ParietalPorts,
  type ParietalPortsDeps,
} from './ports.ts'
export {
  adminPresenceProcedures,
  type PresenceProcedureDeps,
  presenceProcedures,
} from './procedures.ts'
export { type ParietalRemovalOptions, PRESENCE_FILE, parietalRemoval } from './removal.ts'
export {
  createParietalService,
  HEARTBEAT_MIN_MS,
  ParietalError,
  type ParietalErrorCode,
  type ParietalRepos,
  type ParietalService,
  type ParietalServiceOptions,
  type RegisterResult,
} from './service.ts'
export {
  PRESENCE_STATUS_SET_DESCRIPTION,
  PRESENCE_STATUS_SET_TOOL,
  type PresenceStatusSetAnswer,
  type PresenceStatusToolOptions,
  parseStatusTime,
  presenceStatusSetToolOf,
} from './status-tool.ts'
export {
  PRESENCE_TOOL,
  type PresenceAnswer,
  presenceTool,
  presenceToolOf,
  resolvePerson,
} from './tool.ts'

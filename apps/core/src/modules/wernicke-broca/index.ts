// Wernicke–Broca: the front agent (docs/specs/wernicke-broca.md).
export {
  CONSENT_INSTRUCTIONS,
  createFrontAgent,
  FRONT_INSTRUCTIONS,
  FRONT_STEPS,
  type FrontAgentOptions,
  type FrontHardening,
  frontSessionId,
  type PersonInfo,
  type WhoIs,
  whoText,
} from './agent.ts'
export {
  type ChatCaller,
  ChatContextError,
  type ChatContextErrorCode,
  type ContextService,
  type ContextServiceDeps,
  createContextService,
  refusalText,
} from './context-service.ts'
export { type FrontGenerations, frontGenerations } from './generations.ts'
export { type ChatProcedureDeps, chatCallerOf, chatProcedures } from './procedures.ts'
export { type WernickeBrocaRemovalOptions, wernickeBrocaRemoval } from './removal.ts'

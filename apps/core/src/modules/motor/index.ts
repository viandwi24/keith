// Motor: how Keith acts on a machine (docs/specs/motor.md).
export {
  announcedDrivers,
  DESKTOP_INSTRUCTIONS,
  framedModelOutputOf,
  MOTOR_INSTRUCTIONS,
  MOTOR_REMOTE_TOOL,
  type MotorOptions,
  type MotorResult,
  motorInstructionsOf,
  motorRemote,
  OUTPUT_MAX_CHARS,
  REMOTE_TIMEOUT_MS,
  riskOf,
  runsUnasked,
} from './remote.ts'
export { type MotorAsk, motorAskOf, motorConsentRisk, ownerAnswers } from './risk.ts'
export {
  createNodeCallLimit,
  createNodeCallLimitSettings,
  NODE_CALL_LIMIT_DEFAULT,
  NODE_CALL_LIMIT_KEY,
  NODE_CALL_LIMIT_MAX,
  type NodeCallLimitSettings,
} from './settings.ts'
export { NODES_STATUS_TOOL, nodesStatus } from './status.ts'

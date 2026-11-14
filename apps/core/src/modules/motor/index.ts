// Motor: how Keith acts on a machine (docs/specs/motor.md).
export {
  announcedDrivers,
  DESKTOP_INSTRUCTIONS,
  MOTOR_INSTRUCTIONS,
  MOTOR_REMOTE_TOOL,
  type MotorOptions,
  type MotorResult,
  motorInstructionsOf,
  motorRemote,
  OUTPUT_MAX_CHARS,
  REMOTE_TIMEOUT_MS,
  riskOf,
} from './remote.ts'
export { type MotorAsk, motorAskOf, ownerAnswers } from './risk.ts'
export {
  createNodeCallLimit,
  createNodeCallLimitSettings,
  NODE_CALL_LIMIT_DEFAULT,
  NODE_CALL_LIMIT_KEY,
  NODE_CALL_LIMIT_MAX,
  type NodeCallLimitSettings,
} from './settings.ts'
export { NODES_STATUS_TOOL, nodesStatus } from './status.ts'

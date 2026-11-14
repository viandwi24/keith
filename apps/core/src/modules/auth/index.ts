// Auth: credentials, legacy tokens, device login and the principal of a request
// (docs/specs/auth.md).
export {
  type Capabilities,
  createCapabilities,
  LEGACY_STEP_UP_MESSAGE,
  roleCapabilities,
  stepUpDenial,
} from './capabilities.ts'
export {
  CREDENTIAL_PREFIX,
  createCredential,
  formatCredential,
  hashSecret,
  LAST_SEEN_EVERY_MS,
  newCredentialId,
  newSecret,
  parseCredential,
  verifyCredential,
} from './credentials.ts'
export {
  createDeviceLogin,
  DEVICE_TTL_MS,
  DeviceError,
  type DeviceLogin,
  type DeviceLoginOptions,
} from './device.ts'
export { createFlowRoutes, FLOW_MAX_FAILURES, FLOW_TTL_MS, type FlowRoutes } from './flow.ts'
export {
  ARGON2,
  createHasher,
  HASH_QUEUE_TIMEOUT_MS,
  type Hasher,
  HasherBusyError,
  type HasherOptions,
  MAX_CONCURRENT_HASHES,
} from './hasher.ts'
export { candidatesOf, identifierKey, normalizeEmail, normalizePhone } from './identifier.ts'
export { createLimiter, type Limiter } from './limiter.ts'
export {
  createLocalAccess,
  LOCAL_SETTING,
  type LocalAccess,
  type LocalAccessOptions,
  type LocalMode,
} from './local-access.ts'
export { isUserActivity } from './local-activity.ts'
export {
  type AuthRoutes,
  type AuthRoutesOptions,
  createAuthRoutes,
  DEFAULT_LOGIN_LABEL,
  type Peer,
  STEP_UP_MS,
} from './login.ts'
export { deviceMethod } from './methods/device.ts'
export { createPasswordMethod, type PasswordMethod } from './methods/password.ts'
export { type AuthRegistry, createAuthRegistry } from './methods/registry.ts'
export { tokenMethod } from './methods/token.ts'
export type { AuthMethod } from './methods/types.ts'
export { isLoopbackIp, isTailscaleIp, methodDecision, networkRule } from './network-rule.ts'
export { checkPassword, checkPin } from './password-rules.ts'
export { allows, DEFAULT_POLICY, type PolicyContext, ruleFor } from './policy.ts'
export {
  createPolicyStore,
  POLICY_SETTING,
  type PolicyStore,
  policyProblem,
} from './policy-store.ts'
export {
  createPrincipalResolver,
  LOCAL_PRINCIPAL,
  type PrincipalResolver,
  type Via,
} from './principal.ts'
export { recoverOwner } from './recover.ts'
export { createThrottle, delayMs, MEMBER_LOCK_AT, type Throttle } from './throttle.ts'
export {
  bearerOf,
  type CredentialRef,
  createToken,
  ensureOwner,
  hashToken,
  isActive,
  newToken,
  OWNER_ID,
  type Principal,
  verifyAuthorization,
} from './tokens.ts'
export {
  createLanNets,
  inCidrs,
  isPrivateIp,
  isValidCidr,
  type LanNets,
  type ZoneResult,
  zoneOf,
} from './zone.ts'

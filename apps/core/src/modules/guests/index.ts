// Guests: anonymous, incognito sessions on a tiny read-only agent (docs/specs/guests.md, ADR-0017).
export { GUEST_PRINCIPAL_PREFIX, guestFactsOf, withGuests } from './actor.ts'
export {
  createGuestAdmin,
  type GuestAdmin,
  type GuestAdminOptions,
  type GuestSessionsPort,
  type GuestSettingsChange,
  noGuestSessions,
} from './admin.ts'
export { createEntryGate, type EntryGate, type EntryGateOptions } from './gate.ts'
export { GUEST_INSTRUCTIONS } from './guest-agent.ts'
export { createGuestAudit, type GuestAudit, type GuestAuditOptions } from './guest-audit.ts'
export {
  createGuestBudget,
  GUEST_TURN_USD,
  GUESTS_SCOPE,
  type GuestBudget,
  type GuestBudgetOptions,
  guestDayScope,
} from './guest-budget.ts'
export type { GuestSessionStats } from './guest-limits.ts'
export { createGuestLogger, type GuestLogContext } from './guest-logger.ts'
export { guestProcedures } from './procedures.ts'
export { inProxyAddrs, isProxyAddr } from './proxy-addrs.ts'
export {
  createGuestRegistry,
  GUEST_SESSION_PREFIX,
  GUEST_TOOL_ALLOWLIST,
  type GuestClientKind,
  type GuestRegistry,
  type GuestRegistryOptions,
  type GuestSession,
  type OpenInput,
  type OpenResult,
} from './registry.ts'
export {
  createGuestSettings,
  GuestError,
  type GuestSettingsStore,
  guestKey,
  KILLED_KEY,
  type SettingsPort,
} from './settings.ts'

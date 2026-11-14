// Amygdala: what waits for the owner (docs/specs/amygdala.md).

export {
  APPROVAL_COMMAND_MAX,
  type ApprovalDescription,
  type AttentionDeps,
  type AttentionOptions,
  type AttentionTrail,
  attentionOptions,
  openQueueSession,
} from './attention.ts'
export { type ApprovalExpiryDeps, expireApprovals, expiredReason } from './expiry.ts'
export { type WatchPendingOptions, watchPending } from './pending.ts'
export {
  APPROVAL_PING_KEY,
  APPROVAL_TTL_KEY,
  type ApprovalChange,
  type ApprovalSettings,
  createApprovalSettings,
} from './settings.ts'

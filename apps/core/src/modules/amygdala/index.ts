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
export { type ClientAuth, createClientAuth } from './client-auth.ts'
export {
  CONSENT_PLUGIN,
  type Consent,
  type ConsentOptions,
  type ConsentRegistry,
  createConsent,
} from './consent.ts'
export {
  CLASSIFIER_MESSAGE_MAX,
  CLASSIFIER_TIMEOUT_MS,
  type ClassifyOptions,
  type ConsentAnswer,
  classifyConsent,
  classifyShort,
  NO_PHRASES,
  normalizeReply,
  SHORT_REPLY_WORDS,
  YES_PHRASES,
} from './consent-classifier.ts'
export { type ConsentContextInput, type ConsentOrigin, consentContext } from './consent-context.ts'
export {
  type ConsentConversation,
  type ConsentConversationDeps,
  type ConsentOutcome,
  createConsentConversation,
  MOVED_ON,
  NO_ANSWER_IN_CONVERSATION,
  SAID_NO,
} from './consent-conversation.ts'
export {
  CONSENT_NOTE_PLUGIN,
  type ConsentNotes,
  consentNoteText,
  createConsentNotes,
} from './consent-note.ts'
export { approvalSummary } from './consent-summary.ts'
export { type ConsentDecision, consentDecision } from './consent-table.ts'
export {
  CONSENT_REQUEST_EVENT,
  type ConsentVoiceDeps,
  createConsentVoice,
  type FreshApproval,
  voiceText,
} from './consent-voice.ts'
export { type ApprovalExpiryDeps, expireApprovals, expiredReason } from './expiry.ts'
export { type WatchPendingOptions, watchPending } from './pending.ts'
export {
  APPROVAL_PING_KEY,
  APPROVAL_TTL_KEY,
  type ApprovalChange,
  type ApprovalSettings,
  createApprovalSettings,
} from './settings.ts'
export { createUndoPlugin, UNDO_LAST_TOOL, UNDO_PLUGIN } from './undo.ts'

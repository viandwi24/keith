// The member lines of the activity-log audit kinds (docs/specs/activity-logs.md, "Audit"; ADR-0032 §8). Imported by `mine.ts`,
// which registers them with its other summaries. A type-only import of `mine.ts` keeps the two modules acyclic.
import type { MySummary } from '../mine.ts'

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** The summaries of the kinds that name a person (`AUDIT_SUBJECT_FIELDS`). Counts and scopes only, never a message or a call. */
export const ACTIVITY_LOG_SUMMARIES: Readonly<Record<string, MySummary>> = {
  'logs.owner-read': (d) => {
    const scope = text(d.scope)
    if (scope === 'list') return 'the owner looked at the list of your model calls'
    if (scope === 'session') return 'the owner looked at one of your sessions in the activity logs'
    if (scope === 'call') return 'the owner looked at one of your model calls in the activity logs'
    if (scope === 'raw')
      return 'the owner looked at the raw request and response of one of your model calls'
    return 'the owner looked at your activity logs'
  },
  'logs.purge': (d) =>
    d.mode === 'all'
      ? 'removed your activity logs (sessions, calls and bodies)'
      : 'removed the stored bodies of your model calls (the figures are kept)',
}

/** Kinds with a subject field that are never shown to the person: the owner reads them in the audit log. */
export const ACTIVITY_LOG_HIDDEN: readonly string[] = ['logs.settings']

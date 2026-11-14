// The candidate the collector hands the judge (docs/specs/dreaming.md, "Collect"). A candidate is one text of the person's
// own front conversation: the text, its role, the session and message it came from, and the day it was said (YYYY-MM-DD).
// Not the contract's `DreamCandidate` (a judge plan entry): the judge's plan refers back to `id`.
export type DreamCandidate = {
  id: string
  text: string
  role: 'user' | 'assistant'
  sessionId: string
  messageId: string
  day: string
}

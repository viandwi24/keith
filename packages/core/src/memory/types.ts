// Memory write and recall, the visibility rule (I-4) and the awareness digest.
// See docs/architecture/memory.md. Implemented by memory/ (task P1-M1).

import type { Memory, MemoryId, NewMemory, PersonId, ThreadId, Viewer } from '../shared/types.ts'

export interface MemoryService {
  write(m: NewMemory): Promise<Memory>
  recall(q: { text: string; viewer: Viewer; limit?: number | undefined }): Promise<Memory[]>
  /** Pinned, visible, capped by `memory.coreMaxChars`. */
  core(viewer: Viewer): Promise<Memory[]>
  /** Subjects and topics that exist but are not in core(). */
  index(viewer: Viewer): Promise<string[]>
  /** Awareness digest, at most 5 lines. */
  digest(a: { threadId: ThreadId; viewer: Viewer }): Promise<string>
}

// Phase 4: reflection and thread summaries (ADR-0014)

/** What one reflection pass over a thread did. */
export type ReflectionResult = {
  threadId: ThreadId
  /** The new reflection cursor: the last message `seq` the pass read. */
  throughSeq: number
  /** Memories written (new, `source: 'inferred'`). */
  written: MemoryId[]
  /** Existing memories whose content was rewritten. */
  merged: MemoryId[]
  /** Persons whose relationship notes were rewritten. */
  cardsUpdated: PersonId[]
}

export interface Reflector {
  /**
   * One pass over the thread's messages after its reflection cursor. Returns null when there is
   * nothing new. Moves the cursor and emits `memory.reflected` on success.
   */
  reflect(a: { threadId: ThreadId; signal: AbortSignal }): Promise<ReflectionResult | null>
}

export interface ThreadSummarizer {
  /**
   * Folds the rows that left the recent-messages window into `threads.summary`. Returns false
   * (and calls no model) when fewer than `memory.summary.minMessages` rows are pending. Emits
   * `thread.summarized` when the summary changed.
   */
  update(a: { threadId: ThreadId; signal: AbortSignal }): Promise<boolean>
}

/** A background job with a lifecycle, started and stopped by bootstrap. */
export interface MemoryJob {
  /** Subscribes to its trigger event. Idempotent. */
  start(): void
  /** Unsubscribes, aborts running passes and resolves once they have settled. */
  stop(): Promise<void>
}

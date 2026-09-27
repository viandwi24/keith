// Memory write and recall, the visibility rule (I-4) and the awareness digest.
// See docs/architecture/memory.md. Implemented by memory/ (task P1-M1).

import type { Memory, NewMemory, ThreadId, Viewer } from '../shared/types.ts'

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

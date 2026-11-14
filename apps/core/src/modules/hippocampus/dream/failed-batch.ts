// The retry of a failed judge batch (docs/specs/dreaming.md "Failed batches", ADR-0031 note 2026-11-12). A judgement that fails (not a
// refusal) keeps the cursor, so the next run judges the same messages once more. The batch is the same when it shares a source message
// with the batch the previous run failed on; a second failure of that batch skips it. The memory of the batch lives in the run row
// (`DreamingRepo.failedBatchOf`), so no file or migration holds it.

/** True when `batch` shares a source message with the batch the previous run failed on (`previous`, undefined when none). */
export function repeatsFailedBatch(
  previous: readonly string[] | undefined,
  batch: readonly string[],
): boolean {
  return previous !== undefined && batch.some((id) => previous.includes(id))
}

/** The diary note of a skipped batch: how many candidates were skipped, and that nothing was changed (no text). */
export const skippedBatchNote = (candidates: number): string =>
  `dropped.failed: ${candidates} candidates were skipped after two failed judgements; nothing was changed`

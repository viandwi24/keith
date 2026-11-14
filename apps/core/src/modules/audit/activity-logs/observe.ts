// Calls outside an agent turn (ADR-0032 §1, docs/specs/activity-logs.md "Aux calls"): a model a plugin or a tool calls itself is
// wrapped with eharness' `observeModel`, and each call it reports is stored under the session `aux:<name>:<personId>`. The row is
// built by the same `toRecord` as a turn's call, so redaction, truncation and the body setting apply alike. Observe-only: it never
// fails the call, and the report swallows its own errors.
import type { LanguageModel } from 'ai'
import { type ModelCallEvent, observeModel } from 'eharness'
import { type CaptureRecord, toRecord } from './capture.ts'
import type { LogQueue } from './queue.ts'
import type { ActivityLogSettings } from './settings.ts'

export interface AuxObserveDeps {
  /** Where the rows go; only `enqueue` is used. */
  queue: Pick<LogQueue<CaptureRecord>, 'enqueue'>
  /** Read per call, so a change of the owner's settings applies to the next call. */
  settings: Pick<ActivityLogSettings, 'get'>
}

/** The session id of an aux call. The registry reads it as kind `aux` with the person it names (`sessionRefOf`). */
export const auxSessionId = (name: string, personId: string): string => `aux:${name}:${personId}`

/**
 * Wraps `model` so each of its calls is recorded under `aux:<name>:<personId>` with kind `other`. The returned model is what the
 * caller passes to `generateText`; the original is untouched. A name with a colon or an empty person matches no kind and its rows
 * are dropped (the registry decides, ADR-0032 §2).
 */
export function observeAux(
  name: string,
  personId: string,
  model: LanguageModel,
  deps: AuxObserveDeps,
): LanguageModel {
  const sessionId = auxSessionId(name, personId)
  return observeModel(model, (record) => {
    try {
      // the call is not part of a turn: no turn id, no step, no trigger; the cost is unknown (no catalog price is passed)
      const event = { ...record, kind: 'other', sessionId } as ModelCallEvent
      const row = toRecord(event, { principalId: personId }, deps.settings.get())
      if (row !== undefined) deps.queue.enqueue(row)
    } catch {
      // a capture failure loses one row, never the call
    }
  })
}

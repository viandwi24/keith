// The flush share of Keith's `compaction.before` hook (docs/specs/dreaming.md "Rule 9", docs/specs/chat-context.md "Flush", ADR-0031 §9,
// ADR-0030 §3, P35.5.5). One hook, two parts. The dreaming part: when the person's mode is not `off` it adds one line to the flush
// prompt, so new lasting facts go to `recent.md` (short-term, with a date and a Source line) and not to topic files or `profile.md`.
// The manual part (eharness 0.13.0, spec 06 §5.2a rule 9a): a manual `compact()` (`/new`, `/compact`) asks for `onFailure: 'abort'`, so a
// flush that failed or was skipped stops the summary and the reset is refused with nothing changed. Automatic compactions (`turn`, `auto`,
// `overflow`) keep the default `'continue'`: a flush skipped because the history is too large must not block them.
// eharness joins the prompts of all hooks, so the memory plugin's own flush prompt is kept. The person is the session principal; no other
// person's mode is read.

import type { DreamingSettings, DreamMode } from '@keith/contracts'
import type { DreamingRepo } from '@keith/db'
import { definePlugin, type HarnessPlugin } from 'eharness'
import { MEMORY_FLUSH_TOOLS } from 'eharness/memory'
import { dayOf } from './collect.ts'

/** The flush line for one day: where new facts go and what they carry. Fixed English text (the model reads it, the person does not). */
export function dreamFlushLine(day: string): string {
  return `Dreaming: write new lasting facts about this person only to recent.md (not to a topic file, not to profile.md). Each fact is one line "- <text>" with the date ${day} and a "Source:" line naming this conversation. Facts that repeat a stored one are not written again.`
}

/**
 * The flush line of a manual compaction. The abort policy needs a prompt (spec 06 §5.2a rule 2: a patch without a non-empty prompt
 * is invalid), so the manual part always carries this one line. It tells the model why the flush runs now.
 */
export const MANUAL_FLUSH_LINE =
  'The person is starting a new context or compacting this one now. Before the history is summarised, save only the lasting facts of this conversation that must survive it.'

export interface DreamFlushOptions {
  repo: Pick<DreamingRepo, 'getMode'>
  owner: { isOwner(personId: string): Promise<boolean> }
  settings(): Pick<DreamingSettings, 'memberDefault'>
  /** Clock of the flush line's date (tests pin it). */
  now?: () => number
}

/** The mode of one person, with the same default as the dreaming service: stored, else `propose` for the owner, else the member default. */
async function modeOf(options: DreamFlushOptions, personId: string): Promise<DreamMode> {
  const stored = options.repo.getMode(personId)
  if (stored !== undefined) return stored
  if (await options.owner.isOwner(personId)) return 'propose'
  return options.settings().memberDefault
}

/** What the hook returns: the flush request eharness merges with the other hooks' (spec 06 §5.2a). */
export interface DreamFlushPatch {
  flush: { prompt: string; tools?: string[]; onFailure?: 'abort' }
}

/** The event of the hook this file reads: only the trigger matters here (spec 06 §5.2a rule 2). */
export interface FlushHookEvent {
  trigger?: 'turn' | 'auto' | 'manual' | 'overflow'
}

/** The dreaming part: the flush patch for the session's person, or nothing when the mode is `off` or no person is set. */
export function dreamFlushHook(
  options: DreamFlushOptions,
): (ctx: { principal?: { id: string } | undefined }) => Promise<DreamFlushPatch | undefined> {
  const now = options.now ?? Date.now
  return async (ctx) => {
    const person = ctx.principal?.id
    if (person === undefined) return undefined
    if ((await modeOf(options, person)) === 'off') return undefined
    return {
      flush: {
        prompt: dreamFlushLine(dayOf(now())),
        tools: [...MEMORY_FLUSH_TOOLS],
      },
    }
  }
}

/** The manual part: `onFailure: 'abort'` for a manual `compact()` only (`/new`, `/compact`); nothing for automatic compactions. */
export function manualFlushPatch(event: FlushHookEvent): DreamFlushPatch | undefined {
  if (event.trigger !== 'manual') return undefined
  return { flush: { prompt: MANUAL_FLUSH_LINE, onFailure: 'abort' } }
}

/** One patch from the two parts: prompts joined with a blank line, tools of the dreaming part, `abort` when the manual part asks for it. */
export function mergeFlushPatches(
  dreaming: DreamFlushPatch | undefined,
  manual: DreamFlushPatch | undefined,
): DreamFlushPatch | undefined {
  if (dreaming === undefined) return manual
  if (manual === undefined) return dreaming
  return {
    flush: {
      prompt: `${dreaming.flush.prompt}\n\n${manual.flush.prompt}`,
      ...(dreaming.flush.tools === undefined ? {} : { tools: dreaming.flush.tools }),
      onFailure: 'abort',
    },
  }
}

/** The `dreaming-flush` plugin: the `compaction.before` hook of the flush share (dreaming line and manual failure policy). */
export function dreamFlushPlugin(options: DreamFlushOptions): HarnessPlugin {
  const hook = dreamFlushHook(options)
  return definePlugin({
    name: 'dreaming-flush',
    setup: () => ({
      hooks: {
        'compaction.before': async (ctx, event) =>
          mergeFlushPatches(await hook(ctx), manualFlushPatch(event)),
      },
    }),
  })
}

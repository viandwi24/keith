// The rule actions of the applier (docs/specs/dreaming.md "Applier", ADR-0031 §4): one function per action that a candidate may take
// after intake (keep, promote, merge, supersede) and the expiry sweep of recent.md. A unit writes through a Draft and returns its
// effect; a refusal throws Refused and the pass drops the candidate. The rules it asks are in rules.ts.

import {
  appendEntry,
  type Context,
  type Draft,
  type Effect,
  findLive,
  gated,
  type Intent,
  Refused,
} from './apply-state.ts'
import type { DreamEntry } from './entries.ts'
import { ARCHIVE_TIER, PROFILE_TIER, RECENT_TIER } from './files.ts'
import { isExpired, normalizeText, promotionBasis } from './rules.ts'

/** A reason for a superseded marker: no `]` and no line break, at most 200 characters. */
function reasonText(reason: string): string {
  const clean = reason
    .replace(/[\]\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return clean.length > 0 ? clean : 'replaced'
}

/** The day of each mention of the intent's text: its own day, the days of the same text in this run, and the `seen` days of recent entries. */
function mentionDays(intent: Intent, ctx: Context, draft: Draft): string[] {
  const key = normalizeText(intent.text)
  const days = ctx.intents
    .filter((other) => normalizeText(other.text) === key)
    .map((other) => other.source.day)
  for (const block of draft.read(RECENT_TIER)) {
    if (
      block.kind === 'dream' &&
      block.superseded === undefined &&
      block.seen !== undefined &&
      normalizeText(block.text) === key
    ) {
      days.push(block.seen)
    }
  }
  return days
}

function keepUnit(intent: Intent, draft: Draft, ctx: Context): Effect {
  const live = findLive(draft, [RECENT_TIER], normalizeText(intent.text))
  if (live !== undefined) {
    if (live.entry.seen === ctx.today) throw new Refused('duplicate')
    draft.write(RECENT_TIER)[live.index] = { ...live.entry, seen: ctx.today }
    return { effect: 'seen', profileAppend: false }
  }
  const entry = gated({ kind: 'dream', text: intent.text, source: intent.source, seen: ctx.today })
  appendEntry(draft.write(RECENT_TIER), entry)
  return { effect: 'kept', profileAppend: false }
}

function promoteUnit(intent: Intent, draft: Draft, ctx: Context): Effect {
  const key = normalizeText(intent.text)
  const basis = promotionBasis({
    days: mentionDays(intent, ctx, draft),
    source: intent.source,
    importance: intent.importance,
  })
  if (basis === null) return keepUnit(intent, draft, ctx) // no rule holds: the fact stays short-term
  if (findLive(draft, [intent.target], key) !== undefined) throw new Refused('duplicate')
  const recent = findLive(draft, [RECENT_TIER], key)
  const source = recent?.entry.source ?? intent.source
  appendEntry(draft.write(intent.target), gated({ kind: 'dream', text: intent.text, source }))
  if (recent !== undefined) draft.write(RECENT_TIER).splice(recent.index, 1) // moved, not deleted
  return { effect: 'promoted', profileAppend: intent.target.kind === 'profile' }
}

function mergeUnit(intent: Intent, draft: Draft, ctx: Context): Effect {
  const found = findLive(
    draft,
    [intent.target, RECENT_TIER, PROFILE_TIER],
    normalizeText(intent.supersedes ?? ''),
  )
  if (found === undefined) return keepUnit(intent, draft, ctx)
  if (normalizeText(found.entry.text) === normalizeText(intent.text)) throw new Refused('duplicate')
  // One Source per entry (the format): the merged line keeps the source it already has.
  const merged = gated({
    ...found.entry,
    text: intent.text,
    ...(found.tier.kind === 'recent' ? { seen: ctx.today } : {}),
  })
  draft.write(found.tier)[found.index] = merged
  return { effect: 'merged', profileAppend: false }
}

function supersedeUnit(intent: Intent, draft: Draft, ctx: Context): Effect {
  const found = findLive(
    draft,
    [intent.target, RECENT_TIER, PROFILE_TIER],
    normalizeText(intent.supersedes ?? ''),
  )
  if (found === undefined) return keepUnit(intent, draft, ctx)
  // The old line is marked in place and a copy goes to the archive: a contradiction never deletes a line.
  const marked: DreamEntry = {
    ...found.entry,
    superseded: { date: ctx.today, reason: reasonText(intent.reason) },
  }
  const archived = gated(marked)
  const fresh = gated({
    kind: 'dream',
    text: intent.text,
    source: intent.source,
    ...(intent.target.kind === 'recent' ? { seen: ctx.today } : {}),
  })
  draft.write(found.tier)[found.index] = marked
  appendEntry(draft.write(ARCHIVE_TIER), archived)
  appendEntry(draft.write(intent.target), fresh)
  return { effect: 'superseded', profileAppend: false }
}

/** Moves the short-term entries not seen for more than 14 days to the archive, marked `expired`. Returns how many moved. */
export function expireEntries(draft: Draft, ctx: Context): number {
  const expired = draft
    .read(RECENT_TIER)
    .filter(
      (block): block is DreamEntry =>
        block.kind === 'dream' &&
        block.superseded === undefined &&
        block.seen !== undefined &&
        isExpired(block.seen, ctx.today),
    )
  const recent = draft.write(RECENT_TIER)
  const archive = draft.write(ARCHIVE_TIER)
  let moved = 0
  for (const entry of expired) {
    let copy: DreamEntry
    try {
      copy = gated({ ...entry, superseded: { date: ctx.today, reason: 'expired' } })
    } catch (error) {
      if (error instanceof Refused) continue // a line that would not pass the gate stays where it is
      throw error
    }
    appendEntry(archive, copy)
    recent.splice(recent.indexOf(entry), 1)
    moved += 1
  }
  return moved
}

export function unitFor(intent: Intent): (intent: Intent, draft: Draft, ctx: Context) => Effect {
  if (intent.action === 'promote') return promoteUnit
  if (intent.action === 'merge') return mergeUnit
  if (intent.action === 'supersede') return supersedeUnit
  return keepUnit
}

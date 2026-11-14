// The code-side applier of a dreaming run (docs/specs/dreaming.md "Applier", ADR-0031 §4). It takes the judge's validated plan, the
// collected candidates and the memory files as the judge saw them (`base`: a content hash per memory path, null when absent), and
// writes the memory files through the dream helpers. The model never writes. Each candidate is one unit: it changes its files all
// or nothing. A unit that would write a file changed since the judge read it is staged as `staged-changed`. A run that breaks a
// global rule (the caps, a `profile.md` change that is not one added entry, the profile size) stages the units it names and runs
// the pass again; a plan the person approved (`/dream apply`) skips that rule. The applier is synchronous: the files are re-read right
// before the first write, and nothing runs in between.
import type { DreamPlan } from '@keith/contracts'
import { looksLikeSecret } from '../secret-guard.ts'
import {
  type Context,
  Draft,
  type DropReason,
  type Intent,
  Refused,
  World,
  type WriteEffect,
} from './apply-state.ts'
import { dreamEntriesOf, parseMemoryFile, renderMemoryFile } from './entries.ts'
import {
  ARCHIVE_TIER,
  type MemoryTier,
  PROFILE_TIER,
  RECENT_TIER,
  readMemoryBytes,
  tierPath,
  topicTier,
} from './files.ts'
import { addedEntries, appendOnlyFallback, checkRewrite, pointerKey } from './guard.ts'

export type { DropReason, WriteEffect } from './apply-state.ts'

import { expireEntries, unitFor } from './apply-units.ts'
import { isDirective, normalizeText, profileDecision, withinRunCaps } from './rules.ts'
import { contentHash } from './staged.ts'
import type { DreamCandidate } from './types.ts'
import { openRunWriter, type RunWriter } from './undo.ts'

export type StageReason = 'staged-changed' | 'profile-proposal' | 'profile-size' | 'cap'
export interface WrittenItem {
  /** The candidate id, or null for the expiry sweep (which is not a candidate). */
  readonly id: string | null
  readonly effect: WriteEffect
  /** The memory-relative paths the unit wrote. */
  readonly paths: readonly string[]
}
export interface StagedItem {
  readonly id: string
  readonly reason: StageReason
}
export interface DroppedItem {
  readonly id: string
  readonly reason: DropReason
}
export interface ApplyCounts {
  /** Every candidate the run judged (answered or not): each one is kept or dropped. */
  readonly candidates: number
  readonly promoted: number
  readonly merged: number
  readonly superseded: number
  readonly kept: number
  readonly expired: number
  readonly dropped: number
  readonly staged: number
}
export interface ApplyResult {
  readonly written: readonly WrittenItem[]
  readonly staged: readonly StagedItem[]
  readonly dropped: readonly DroppedItem[]
  readonly counts: ApplyCounts
  /** The memory-relative paths whose rewrite the entry-loss guard refused: those files got the append-only fallback. */
  readonly rewriteRejected: readonly string[]
}

export interface ApplyInput {
  readonly dataDir: string
  readonly personId: string
  readonly runId: string
  /** The day of the run (`YYYY-MM-DD`): the `seen` date, the expiry clock and the supersede date. */
  readonly today: string
  readonly plan: DreamPlan
  readonly candidates: readonly DreamCandidate[]
  /** The content hash of each memory file when the judge read it, keyed by memory-relative path; a missing key is an absent file. */
  readonly base: Readonly<Record<string, string | null>>
  /** When true, nothing is written: the result says what would be written. */
  readonly dryRun?: boolean
  /**
   * When true, the person approved this plan (`/dream apply`): the global rules (the caps, the `profile.md` proposal and size) do not
   * stage its units, since the approval is the answer they ask for. Every per-unit guard still applies (intake, the rewrite guard,
   * the base and changed checks).
   */
  readonly approved?: boolean
  /** The writer of the run's files (the default is `openRunWriter`); a test injects one that fails a write. */
  readonly writer?: RunWriter
}

type Settled =
  | {
      readonly kind: 'applied'
      readonly id: string
      readonly text: string
      readonly effect: WriteEffect
      readonly profileAppend: boolean
      readonly tiers: readonly MemoryTier[]
    }
  | { readonly kind: 'dropped'; readonly id: string; readonly reason: DropReason }
  | { readonly kind: 'staged'; readonly id: string; readonly reason: StageReason }

function tierOfTarget(target: string): MemoryTier {
  if (target === 'profile') return PROFILE_TIER
  if (target === 'recent') return RECENT_TIER
  return topicTier(target) // throws for the reserved names (profile.md, recent.md, archive.md)
}

/** Plan candidates that may go on: the source is known, the action is not `drop`, the text is clean and no style, target or secret refuses it. */
function intakeOf(
  plan: DreamPlan,
  candidates: readonly DreamCandidate[],
): { intents: Intent[]; dropped: DroppedItem[] } {
  const intents: Intent[] = []
  const dropped: DroppedItem[] = []
  const seenIds = new Set<string>()
  for (const candidate of plan.candidates) {
    const id = candidate.id
    const refuse = (reason: DropReason) => dropped.push({ id, reason })
    if (seenIds.has(id)) {
      refuse('duplicate')
      continue
    }
    seenIds.add(id)
    const source = candidates.find((c) => c.id === id && c.messageId === candidate.sourceMessageId)
    if (source === undefined) {
      refuse('source')
      continue
    }
    if (candidate.action === 'drop') {
      refuse('drop')
      continue
    }
    const text = candidate.text.replace(/\s+/g, ' ').trim()
    if (text.length === 0) {
      refuse('format')
      continue
    }
    if (looksLikeSecret(text)) {
      refuse('secret')
      continue
    }
    // The directive gate reads the source message too: a reworded plan text ("Answers in French") must not launder an instruction
    // the person wrote ("Always answer in French"). A source message with a directive sentence drops each candidate from it.
    if (isDirective(source.text) || isDirective(text)) {
      refuse('directive')
      continue
    }
    let target: MemoryTier
    try {
      target = tierOfTarget(candidate.target)
    } catch {
      refuse('target')
      continue
    }
    const needsMatch = candidate.action === 'merge' || candidate.action === 'supersede'
    const keep =
      candidate.action === 'keep-short-term' ||
      (candidate.action === 'promote' && target.kind === 'recent') ||
      (needsMatch && candidate.supersedes === undefined)
    intents.push({
      id,
      action: keep ? 'keep-short-term' : candidate.action,
      target: keep ? RECENT_TIER : target,
      text,
      reason: candidate.reason,
      importance: candidate.importance,
      supersedes: candidate.supersedes,
      source,
    })
  }
  return { intents, dropped }
}

interface Pass {
  readonly world: World
  readonly settled: Settled[]
  readonly expired: number
}

/** Why a unit is held back: a global rule stages it, or the entry-loss guard refuses its rewrite (it is dropped). */
type Exclusion = StageReason | 'rewrite-rejected'

/** One pass over the candidates in order, each on the state the earlier committed units left. `sweep` false skips the expiry. */
function runPass(
  ctx: Context,
  world: World,
  exclusions: ReadonlyMap<string, Exclusion>,
  sweep: boolean,
): Pass {
  const settled: Settled[] = []
  for (const intent of ctx.intents) {
    const excluded = exclusions.get(intent.id)
    if (excluded === 'rewrite-rejected') {
      settled.push({ kind: 'dropped', id: intent.id, reason: 'rewrite-rejected' })
      continue
    }
    if (excluded !== undefined) {
      settled.push({ kind: 'staged', id: intent.id, reason: excluded })
      continue
    }
    const draft = new Draft(world)
    try {
      const effect = unitFor(intent)(intent, draft, ctx)
      const tiers = draft.tiers()
      if (tiers.some((tier) => world.isChanged(tier))) {
        settled.push({ kind: 'staged', id: intent.id, reason: 'staged-changed' })
      } else {
        draft.commit()
        settled.push({ kind: 'applied', id: intent.id, text: intent.text, ...effect, tiers })
      }
    } catch (error) {
      if (!(error instanceof Refused)) throw error
      settled.push({ kind: 'dropped', id: intent.id, reason: error.reason })
    }
  }
  let expired = 0
  if (sweep && !world.isChanged(RECENT_TIER) && !world.isChanged(ARCHIVE_TIER)) {
    const draft = new Draft(world)
    expired = expireEntries(draft, ctx)
    if (expired > 0) draft.commit()
  }
  return { world, settled, expired }
}

/**
 * The files whose rewrite the entry-loss guard refuses, keyed by memory-relative path, with the guard's reason. An entry that
 * left a file for another changed file in this run (a promotion) was moved, not lost: the guard judges the file as if it stayed.
 */
export function rewriteRejects(world: World): Map<string, string> {
  const files = world.changedFiles()
  const landed = new Set(
    files.flatMap((file) =>
      addedEntries(file.original, file.blocks).map((entry) => normalizeText(entry.text)),
    ),
  )
  const out = new Map<string, string>()
  for (const file of files) {
    const stays = new Set(
      file.blocks.flatMap((block) => (block.kind === 'dream' ? [pointerKey(block)] : [])),
    )
    const moved = dreamEntriesOf(parseMemoryFile(file.original)).filter(
      (entry) => !stays.has(pointerKey(entry)) && landed.has(normalizeText(entry.text)),
    )
    const check = checkRewrite(file.original, renderMemoryFile([...file.blocks, ...moved]))
    if (!check.ok) out.set(tierPath(file.tier), check.reason)
  }
  return out
}

/** True when a dream entry with this text is new in some changed file (a unit that landed its entry keeps its effect). */
function landsIn(world: World, text: string): boolean {
  const key = normalizeText(text)
  return world
    .changedFiles()
    .some((file) =>
      addedEntries(file.original, file.blocks).some((entry) => normalizeText(entry.text) === key),
    )
}

/** The units a global rule stages: the caps, then the `profile.md` rule. Empty when the pass may stand. */
function globalExclusions(pass: Pass): Map<string, StageReason> {
  const out = new Map<string, StageReason>()
  const applied = pass.settled.filter(
    (s): s is Extract<Settled, { kind: 'applied' }> => s.kind === 'applied',
  )
  const files = pass.world.changedFiles()
  if (!withinRunCaps({ candidates: applied.length, files: files.length })) {
    for (const unit of applied) out.set(unit.id, 'cap')
    return out
  }
  const profile = applied.filter((unit) => unit.tiers.some((tier) => tier.kind === 'profile'))
  const decision = profileDecision({
    changes: profile.length,
    appendOnly: profile.every((unit) => unit.profileAppend),
    resultChars: renderMemoryFile(pass.world.load(PROFILE_TIER).blocks).length,
  })
  if (decision === 'size' || decision === 'proposal') {
    for (const unit of profile)
      out.set(unit.id, decision === 'size' ? 'profile-size' : 'profile-proposal')
  }
  return out
}

/**
 * A write of the plan failed after at least one file of the run had changed: the files already written stay changed, and the run's
 * undo window keeps them restorable (`apply-partial`). A failure of the first write changes nothing and is thrown as it is.
 */
export class ApplyPartialError extends Error {
  constructor(
    /** How many files the run had changed before the write that failed. */
    readonly written: number,
    cause: unknown,
  ) {
    super(
      `apply stopped after ${written} file(s) were written: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'ApplyPartialError'
  }
}

/**
 * Applies the judge's plan under the rules of ADR-0031 §4, or, with `dryRun`, says what it would write. The memory files are written
 * through the run writer, so the first write of each file keeps its preimage for `dream.undo`. Throws (before any write) when a file
 * changed between the last read and the write.
 */
export function applyPlan(input: ApplyInput): ApplyResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.today))
    throw new Error(`not a day: ${JSON.stringify(input.today)}`)
  const intake = intakeOf(input.plan, input.candidates)
  const ctx: Context = { today: input.today, intents: intake.intents }
  // A candidate the plan does not name changes no memory: it is dropped as `absent` (the judge answers only for changes).
  const answered = new Set(input.plan.candidates.map((candidate) => candidate.id))
  const absent: DroppedItem[] = input.candidates
    .filter((candidate) => !answered.has(candidate.id))
    .map((candidate) => ({ id: candidate.id, reason: 'absent' }))

  const exclusions = new Map<string, Exclusion>()
  let sweep = true
  let pass: Pass
  let rejects = new Map<string, string>()
  for (;;) {
    pass = runPass(ctx, new World(input.dataDir, input.personId, input.base), exclusions, sweep)
    // an approved plan is the person's answer to the global rules: they stage nothing here
    const global = input.approved === true ? new Map<string, StageReason>() : globalExclusions(pass)
    const fresh = [...global].filter(([id]) => !exclusions.has(id))
    if (fresh.length > 0) {
      for (const [id, reason] of fresh) exclusions.set(id, reason)
      continue
    }
    rejects = rewriteRejects(pass.world)
    if (rejects.size === 0) break
    // A refused rewrite keeps the file's prior bytes and appends only the new entries. A unit that cannot land its entry in
    // any file is held back as a whole (`rewrite-rejected`); the expiry sweep is skipped when it would rewrite a refused file.
    let moved = false
    if (sweep && (rejects.has(tierPath(RECENT_TIER)) || rejects.has(tierPath(ARCHIVE_TIER)))) {
      sweep = false
      moved = true
    }
    for (const unit of pass.settled) {
      if (unit.kind !== 'applied') continue
      if (!unit.tiers.some((tier) => rejects.has(tierPath(tier)))) continue
      if (landsIn(pass.world, unit.text)) continue
      exclusions.set(unit.id, 'rewrite-rejected')
      moved = true
    }
    if (!moved) break
  }

  const changed = pass.world.changedFiles()
  for (const file of changed) {
    if (contentHash(readMemoryBytes(input.dataDir, input.personId, file.tier)) !== file.hash) {
      throw new Error(`memory file changed during apply: ${tierPath(file.tier)}`)
    }
  }
  // The bytes each file ends with: the rendered rewrite, or for a refused rewrite the prior bytes plus the new entries.
  const contents = changed.flatMap((file) => {
    const content = rejects.has(tierPath(file.tier))
      ? appendOnlyFallback(file.original, addedEntries(file.original, file.blocks))
      : renderMemoryFile(file.blocks)
    return content === file.original ? [] : [{ file, content }]
  })
  if (input.dryRun !== true) {
    const writer = input.writer ?? openRunWriter(input.dataDir, input.personId, input.runId)
    let done = 0
    for (const { file, content } of contents) {
      try {
        writer.write(file.tier, content)
      } catch (error) {
        if (done === 0) throw error
        throw new ApplyPartialError(done, error)
      }
      done += 1
    }
  }

  const applied = pass.settled.filter(
    (s): s is Extract<Settled, { kind: 'applied' }> => s.kind === 'applied',
  )
  const written: WrittenItem[] = applied.map((unit) => ({
    id: unit.id,
    effect: unit.effect,
    paths: unit.tiers.map(tierPath),
  }))
  if (pass.expired > 0)
    written.push({
      id: null,
      effect: 'expired',
      paths: [tierPath(RECENT_TIER), tierPath(ARCHIVE_TIER)],
    })
  const staged: StagedItem[] = pass.settled.flatMap((s) =>
    s.kind === 'staged' ? [{ id: s.id, reason: s.reason }] : [],
  )
  const dropped: DroppedItem[] = [
    ...absent,
    ...intake.dropped,
    ...pass.settled.flatMap((s) => (s.kind === 'dropped' ? [{ id: s.id, reason: s.reason }] : [])),
  ]
  const count = (effect: WriteEffect) => written.filter((w) => w.effect === effect).length
  return {
    written,
    staged,
    dropped,
    counts: {
      candidates: input.candidates.length,
      promoted: count('promoted'),
      merged: count('merged'),
      superseded: count('superseded'),
      kept: count('kept') + count('seen'),
      expired: pass.expired,
      dropped: dropped.length,
      staged: staged.length,
    },
    rewriteRejected: [...rejects.keys()],
  }
}

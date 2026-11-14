// The state of one applier pass (docs/specs/dreaming.md "Applier", ADR-0031 §4): the memory files as read (World), the writes of
// one candidate over copies of them (Draft), the candidate as the applier sees it (Intent), the effect a unit reports and the refusal
// a unit raises. The rule actions are in apply-units.ts; the plan, the passes and the writes are in apply.ts.
import type { DreamAction } from '@keith/contracts'
import { looksLikeSecret } from '../secret-guard.ts'
import {
  assertEntry,
  type DreamEntry,
  type MemoryBlock,
  parseMemoryFile,
  renderEntry,
  renderMemoryFile,
} from './entries.ts'
import { type MemoryTier, readMemoryBytes, tierPath } from './files.ts'
import { normalizeText } from './rules.ts'
import { contentHash } from './staged.ts'
import type { DreamCandidate } from './types.ts'

export type WriteEffect = 'kept' | 'seen' | 'promoted' | 'merged' | 'superseded' | 'expired'

export type DropReason =
  | 'drop'
  | 'source'
  | 'target'
  | 'directive'
  | 'secret'
  | 'format'
  | 'duplicate'
  | 'rewrite-rejected'
  /** A candidate the judge did not name: it changes no memory, so it is dropped (docs/specs/dreaming.md, "Judge"). */
  | 'absent'

export type IntentAction = Exclude<DreamAction, 'drop'>

/** A plan candidate that survived intake: its source is known, its text is clean, its target is a tier. */
export interface Intent {
  readonly id: string
  readonly action: IntentAction
  readonly target: MemoryTier
  readonly text: string
  readonly reason: string
  readonly importance: number
  readonly supersedes: string | undefined
  readonly source: DreamCandidate
}

/** A unit's effect on the files: what it did, and whether it only added one entry to `profile.md`. */
export interface Effect {
  readonly effect: WriteEffect
  readonly profileAppend: boolean
}

/** A unit that is refused with a reason (nothing of it is written). */
export class Refused extends Error {
  constructor(readonly reason: DropReason) {
    super(reason)
  }
}

export interface Context {
  readonly today: string
  readonly intents: readonly Intent[]
}

export interface Loaded {
  readonly tier: MemoryTier
  /** The file text as read (empty when absent). */
  readonly original: string
  readonly hash: string | null
  blocks: MemoryBlock[]
}

/** The memory files of one pass, read once from disk (a new pass reads them again). */
export class World {
  private readonly loaded = new Map<string, Loaded>()

  constructor(
    private readonly dataDir: string,
    private readonly personId: string,
    private readonly base: Readonly<Record<string, string | null>>,
  ) {}

  load(tier: MemoryTier): Loaded {
    const path = tierPath(tier)
    const cached = this.loaded.get(path)
    if (cached !== undefined) return cached
    const bytes = readMemoryBytes(this.dataDir, this.personId, tier)
    const text = bytes === undefined ? '' : new TextDecoder().decode(bytes)
    const entry: Loaded = {
      tier,
      original: text,
      hash: contentHash(bytes),
      blocks: parseMemoryFile(text),
    }
    this.loaded.set(path, entry)
    return entry
  }

  /** True when the file's content differs from the hash the judge saw. */
  isChanged(tier: MemoryTier): boolean {
    return this.load(tier).hash !== (this.base[tierPath(tier)] ?? null)
  }

  setBlocks(tier: MemoryTier, blocks: MemoryBlock[]): void {
    this.load(tier).blocks = blocks
  }

  /** The files whose rendered text differs from what was read. */
  changedFiles(): Loaded[] {
    return [...this.loaded.values()].filter(
      (file) => renderMemoryFile(file.blocks) !== file.original,
    )
  }
}

/** The writes of one unit, over copies of the world's files. Committed only when the unit is not refused or staged. */
export class Draft {
  private readonly changes = new Map<string, { tier: MemoryTier; blocks: MemoryBlock[] }>()

  constructor(private readonly world: World) {}

  read(tier: MemoryTier): readonly MemoryBlock[] {
    return this.changes.get(tierPath(tier))?.blocks ?? this.world.load(tier).blocks
  }

  write(tier: MemoryTier): MemoryBlock[] {
    const path = tierPath(tier)
    let change = this.changes.get(path)
    if (change === undefined) {
      change = { tier, blocks: [...this.world.load(tier).blocks] }
      this.changes.set(path, change)
    }
    return change.blocks
  }

  tiers(): MemoryTier[] {
    return [...this.changes.values()].map((change) => change.tier)
  }

  commit(): void {
    for (const change of this.changes.values()) this.world.setBlocks(change.tier, change.blocks)
  }
}

/** The entry as the file format writes it. Refuses (`format`) a text the format cannot hold, and (`secret`) a secret-shaped line. */
export function gated(entry: DreamEntry): DreamEntry {
  let lines: string[]
  try {
    lines = renderEntry(assertEntry(entry))
  } catch {
    throw new Refused('format')
  }
  if (lines.some((line) => looksLikeSecret(line))) throw new Refused('secret')
  return entry
}

/** Adds an entry at the end of the file, before its final newline (a file always ends with one). */
export function appendEntry(blocks: MemoryBlock[], entry: DreamEntry): void {
  const last = blocks[blocks.length - 1]
  if (last === undefined || last.kind !== 'front' || last.line !== '')
    blocks.push({ kind: 'front', line: '' })
  blocks.splice(blocks.length - 1, 0, entry)
}

export interface Found {
  readonly tier: MemoryTier
  readonly index: number
  readonly entry: DreamEntry
}

/** The first live (not superseded) dreaming entry with the key, in the given tiers. */
export function findLive(
  draft: Draft,
  tiers: readonly MemoryTier[],
  key: string,
): Found | undefined {
  for (const tier of tiers) {
    const blocks = draft.read(tier)
    const index = blocks.findIndex(
      (block) =>
        block.kind === 'dream' &&
        block.superseded === undefined &&
        normalizeText(block.text) === key,
    )
    if (index >= 0) return { tier, index, entry: blocks[index] as DreamEntry }
  }
  return undefined
}

// UI blocks on assistant messages: validation (docs/contracts/ui-blocks.md) and the lookup behind
// `ui.action` (docs/architecture/ui.md#interactivity).

import { type ActionsBlock, UiBlock } from '@keith/protocol'
import type { Logger } from '../shared/types.ts'
import type { MessageUiEntry } from '../storage/types.ts'

type UiAction = ActionsBlock['actions'][number]

function childrenOf(block: UiBlock): UiBlock[] {
  if (block.type === 'card') return block.children ?? []
  if (block.type === 'stack') return block.children
  return []
}

/** Every block of a tree, the root first. */
function* walk(block: UiBlock): Generator<UiBlock> {
  yield block
  for (const child of childrenOf(block)) yield* walk(child)
}

/**
 * A tool's block, validated against the schema and its limits (depth, size, URL schemes, ids
 * unique in the tree). Null, with a logged warning, when it is invalid: the turn goes on without it.
 */
export function validUiBlock(raw: unknown, log: Logger, where: Record<string, unknown>): UiBlock | null {
  const parsed = UiBlock.safeParse(raw)
  if (parsed.success) return parsed.data
  log.warn('tool returned an invalid ui block; dropped', {
    ...where,
    issues: parsed.error.issues.map((i) => i.message).join('; '),
  })
  return null
}

/** True when no block id of `block` is already used by a block of the message. */
export function idsFreeIn(block: UiBlock, entries: readonly MessageUiEntry[]): boolean {
  const used = new Set<string>()
  for (const e of entries) for (const b of walk(e.block)) used.add(b.id)
  for (const b of walk(block)) if (used.has(b.id)) return false
  return true
}

/** The `actions` block `blockId` (at any depth) of a message and its action `actionId`, or null. */
export function findUiAction(
  entries: readonly MessageUiEntry[],
  blockId: string,
  actionId: string,
): { entry: MessageUiEntry; action: UiAction } | null {
  for (const entry of entries) {
    for (const block of walk(entry.block)) {
      if (block.id !== blockId) continue
      if (block.type !== 'actions') return null
      const action = block.actions.find((x) => x.id === actionId)
      return action ? { entry, action } : null
    }
  }
  return null
}

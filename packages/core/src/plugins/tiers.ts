import type { Tier } from '../shared/types.ts'

const RANK: Record<Tier, number> = { guest: 0, member: 1, owner: 2 }

/** True when `tier` is at or above `min` (owner > member > guest). */
export function tierAllows(tier: Tier, min: Tier): boolean {
  return RANK[tier] >= RANK[min]
}

/** The lowest tier in the list, or undefined for an empty list. */
export function lowestTier(tiers: readonly Tier[]): Tier | undefined {
  let lowest: Tier | undefined
  for (const t of tiers) if (lowest === undefined || RANK[t] < RANK[lowest]) lowest = t
  return lowest
}

import type { ProtocolProposal } from '@keith/contracts'

/** How often the app asks the core for the person's pending proposals (a small read). */
export const PROPOSAL_POLL_MS = 60_000

/** The one line of the toast: the reason, cut short, and where to answer it. */
export const proposalLine = (p: ProtocolProposal): string => {
  const reason = p.reason.length > 60 ? `${p.reason.slice(0, 59)}…` : p.reason
  return `new protocol proposal: ${reason} · Apps > Protocols`
}

/**
 * The pending proposals not yet announced in this session, oldest first. Each one is added to `seen`, so a proposal
 * is announced once; a confirmed, dismissed or expired one is not pending and is never announced.
 */
export function freshProposals(
  list: readonly ProtocolProposal[],
  seen: Set<string>,
): ProtocolProposal[] {
  const fresh = list
    .filter((p) => p.status === 'pending' && !seen.has(p.id))
    .sort((a, b) => a.createdAt - b.createdAt)
  for (const p of fresh) seen.add(p.id)
  return fresh
}

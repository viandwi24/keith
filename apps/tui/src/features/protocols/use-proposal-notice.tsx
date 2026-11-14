import type { KeithClient } from '@keith/client'
import { useToast } from '@keith/ui'
import { useEffect } from 'react'
import { freshProposals, PROPOSAL_POLL_MS, proposalLine } from './proposal-notice.ts'

/**
 * Announces each new pending protocol proposal of this person as one toast line (ADR-0019: a notice, never a screen).
 * Read at mount and every minute; a failed read (signed out, core unreachable) stops the polling until the app is
 * mounted again, so a logged-out terminal does not keep asking.
 */
export function useProposalNotice(client: KeithClient): void {
  const { push } = useToast()
  useEffect(() => {
    const seen = new Set<string>()
    let stopped = false
    const check = async (): Promise<void> => {
      if (stopped) return
      try {
        const { proposals } = await client.rpc.protocols.proposals()
        for (const p of freshProposals(proposals, seen)) push(proposalLine(p), { level: 'info' })
      } catch {
        stopped = true
        clearInterval(timer)
      }
    }
    const timer = setInterval(() => void check(), PROPOSAL_POLL_MS)
    void check()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [client, push])
}

/** Mounts the proposal notice for one client (the app keeps one per connection); draws nothing. */
export function ProposalNotice({ client }: { client: KeithClient }) {
  useProposalNotice(client)
  return null
}

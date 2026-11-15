import type { OrbMode } from '@keith/ui/orb'
import { approvals } from '../approvals/index.ts'
import { frontChat } from '../chat/index.ts'
import { connection } from '../connection/index.ts'
import { orbModeFor } from './orb-signals.ts'

/** The orb's mode from the same signals the TUI reads: the front turn, the link, and (web) approvals that wait. */
class OrbState {
  mode: OrbMode = $derived.by(() => {
    const ctl = frontChat.ctl
    return orbModeFor({
      link: connection.link.kind,
      approvals: approvals.answerable.length,
      busy: ctl?.busy ?? false,
      speaking: ctl?.busy === true && ctl.status === 'streaming' && ctl.last?.kind === 'assistant',
      typing: (ctl?.draft ?? '') !== '',
    })
  })
}

export const orbState = new OrbState()

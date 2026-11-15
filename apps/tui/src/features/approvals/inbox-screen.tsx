import { Txt, useFooter } from '@keith/ui'
import { Box } from 'ink'
import { ApprovalDialog } from './approval-dialog.tsx'
import type { Approvals } from './use-attention.ts'

export interface InboxScreenProps {
  approvals: Approvals
  focused: boolean
  onFocusChange(focused: boolean): void
  width: number
}

const HINTS = [
  { key: 'tab', action: 'answer', priority: 80 },
  { key: 'esc', action: 'back', priority: 90 },
] as const

/**
 * `/inbox`: every pending approval, one dialog at a time, with the rule of the bar kept (keys only after
 * `tab`). This is the only place a `device` request or another person's request can be answered in the
 * TUI; a `conversation` request is listed here too, as the fallback to typing the answer.
 */
export function InboxScreen({ approvals, focused, onFocusChange, width }: InboxScreenProps) {
  useFooter(focused ? [] : HINTS)
  return (
    <Box flexDirection="column">
      {approvals.items.length === 0 ? (
        <Txt tone="muted">Nothing is waiting for you.</Txt>
      ) : (
        <ApprovalDialog
          approvals={approvals}
          focused={focused}
          onFocusChange={onFocusChange}
          width={width}
        />
      )}
    </Box>
  )
}

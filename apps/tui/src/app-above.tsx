import { GUTTER, Notice } from '@keith/ui'
import { Box } from 'ink'
import type { ReactNode } from 'react'
import { ApprovalDialog, type Approvals, ConsentLine } from './features/approvals/index.ts'
import { type StepUp, StepUpDialog } from './features/stepup/index.ts'

export interface ChatAboveProps {
  /** The cards that stay in the chat (an old core's items). */
  approvals: Approvals
  /** Every pending approval: the quiet line says what waits without a card. */
  allApprovals: Approvals
  stepUp: StepUp
  /** The step-up prompt is open and the chat is the screen it shows on. */
  stepUpHere: boolean
  /** The approval dialog owns the keys. */
  barHasKeys: boolean
  onBarFocus(focused: boolean): void
  /** The failed refresh of the approvals inbox, when nothing waits. */
  failed: string | undefined
  /** The activity strip that stands in for a hidden sidebar. */
  strip: ReactNode
  width: number
}

/** What sits between the messages and the input: a failed approvals refresh, the step-up prompt, the approval dialog, the strip. */
export function ChatAbove({
  approvals,
  allApprovals,
  stepUp,
  stepUpHere,
  barHasKeys,
  onBarFocus,
  failed,
  strip,
  width,
}: ChatAboveProps): ReactNode {
  const stepUpOpen = stepUp.prompt !== undefined
  if (
    approvals.items.length === 0 &&
    allApprovals.items.length === 0 &&
    strip === undefined &&
    failed === undefined &&
    !stepUpHere
  ) {
    return undefined
  }
  return (
    <Box flexDirection="column">
      {failed !== undefined && (
        <Box marginTop={1} paddingLeft={2}>
          <Notice level="warning" rows={[failed]} />
        </Box>
      )}
      {stepUpHere && (
        <Box marginTop={1}>
          <StepUpDialog stepUp={stepUp} width={width - GUTTER} />
        </Box>
      )}
      {approvals.items.length > 0 && !stepUpOpen && (
        <Box marginTop={1}>
          <ApprovalDialog
            approvals={approvals}
            focused={barHasKeys}
            onFocusChange={onBarFocus}
            width={width - GUTTER}
          />
        </Box>
      )}
      {approvals.items.length === 0 && allApprovals.items.length > 0 && (
        <Box marginTop={1}>
          <ConsentLine items={allApprovals.items} />
        </Box>
      )}
      {strip !== undefined && <Box marginTop={1}>{strip}</Box>}
    </Box>
  )
}

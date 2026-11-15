import { askedAgo, askOf, isWaitingForOwner, lifeOf, offersTaskGrant } from '@keith/app-model'
import type { AttentionItem } from '@keith/client'
import { Chip, Dialog, dialogInner, G, KeyHints, TextInput, Txt, useToast } from '@keith/ui'
import { Box } from 'ink'
import { useEffect, useState } from 'react'
import { useGuardedInput as useInput } from '../activity/index.ts'
import { WAITING_TEXT } from '../stepup/index.ts'
import type { Approvals } from './use-attention.ts'

export interface ApprovalDialogProps {
  approvals: Approvals
  /** The dialog has the keys (Tab toggles it); the chat input is off meanwhile. */
  focused: boolean
  onFocusChange(focused: boolean): void
  /** Width of the left column. */
  width: number
}

const KEYS = [
  { key: 'y', action: 'allow', priority: 90 },
  { key: 'n', action: 'deny', priority: 90 },
  { key: 'N', action: 'reason', priority: 40 },
  { key: 'a', action: 'allow for task', priority: 30 },
  { key: 'tab', action: 'back', priority: 80 },
] as const

/** The clock of the dialog: re-read every `everyMs`, so the age and the amber warning move on their own. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

/**
 * The approval dialog above the input band, shown while approvals wait (oldest first, "1 of N").
 *
 * Keys: the chat input keeps every key, so typing never answers by accident. `Tab` moves the keys
 * to the dialog; there `y` allows, `n` denies, `N` denies with a typed reason (Enter sends, Esc
 * cancels), `a` allows for the rest of the task (that node and capability only), `Tab` or `Esc`
 * goes back to the chat. The dialog leaves focus by itself when nothing waits any more.
 */
export function ApprovalDialog({ approvals, focused, onFocusChange, width }: ApprovalDialogProps) {
  const { items, answerable } = approvals
  // the reason being typed belongs to one item: if it is answered elsewhere, the draft is dropped
  const [draft, setDraft] = useState<{ id: string; text: string } | undefined>()
  // answerable items first; a member's owner-routed items show read only when nothing else waits
  const shown = answerable.length > 0 ? answerable : items
  const current: AttentionItem | undefined = shown[0]
  const readOnly = current !== undefined && isWaitingForOwner(current)
  const reason = draft?.id === current?.id ? draft?.text : undefined
  const now = useNow(30_000)
  const { push } = useToast()
  const life = current === undefined ? undefined : lifeOf(current, now)
  const expiredId = life?.expired === true ? current?.id : undefined
  // the core denies an expired request at its next sweep: say so once while it is on screen
  useEffect(() => {
    if (expiredId !== undefined) push('request expired', { level: 'warning' })
  }, [expiredId, push])
  const scopable = current !== undefined && offersTaskGrant(current)
  const setReason = (text: string | undefined) =>
    setDraft(text === undefined || current === undefined ? undefined : { id: current.id, text })

  useInput(
    (input, key) => {
      if (current === undefined) return
      if (reason !== undefined) {
        if (key.escape) setReason(undefined)
        return
      }
      if (key.tab) return onFocusChange(!focused)
      if (!focused) return
      if (key.escape) return onFocusChange(false)
      if (input === 'y') approvals.approve(current)
      else if (input === 'n') approvals.deny(current)
      else if (input === 'N') setReason('')
      else if (input === 'a' && scopable) approvals.approveForSession(current)
    },
    { isActive: current !== undefined && !readOnly },
  )

  if (current === undefined) return null
  const ask = askOf(current)
  const footer = readOnly ? undefined : reason !== undefined ? (
    <Box>
      <Txt tone="muted">{`reason ${G.prompt} `}</Txt>
      <TextInput
        value={reason}
        width={Math.max(10, width - 14)}
        placeholder="enter to deny, esc to cancel"
        onChange={setReason}
        onSubmit={(text) => {
          const value = text.trim()
          setReason(undefined)
          approvals.deny(current, value === '' ? undefined : value)
        }}
      />
    </Box>
  ) : focused ? (
    <KeyHints
      hints={scopable ? KEYS : KEYS.filter((k) => k.key !== 'a')}
      width={dialogInner(width)}
    />
  ) : (
    <Txt tone="muted">tab to answer</Txt>
  )
  return (
    <Dialog
      title="Approval needed"
      count={`1 of ${shown.length}`}
      focused={focused && !readOnly}
      width={width}
      footer={footer}
    >
      <Txt>{ask.headline}</Txt>
      {ask.command !== undefined && (
        <Chip>
          <Box flexShrink={0}>
            <Txt tone="muted">{`${G.shell} `}</Txt>
          </Box>
          <Box flexShrink={1}>
            <Txt>{ask.command}</Txt>
          </Box>
        </Chip>
      )}
      {ask.actions !== undefined && (
        <Chip>
          <Box flexDirection="column">
            {ask.actions.map((action, index) => (
              <Txt key={`${index}:${action}`}>{action}</Txt>
            ))}
          </Box>
        </Chip>
      )}
      {ask.detail !== undefined && (
        <Chip>
          <Txt>{ask.detail}</Txt>
        </Chip>
      )}
      {ask.task !== undefined && <Txt tone="muted">{`task  ${ask.task}`}</Txt>}
      {life?.ageMs !== undefined && (
        <Txt tone={life.soon || life.expired ? 'warning' : 'muted'}>
          {`${askedAgo(life.ageMs)}${life.soon ? ' · expires soon' : ''}${life.expired ? ' · expired' : ''}`}
        </Txt>
      )}
      {readOnly && <Txt tone="warning">{`${G.working} ${WAITING_TEXT}`}</Txt>}
      {approvals.error !== undefined && <Txt tone="danger">{`${G.failed} ${approvals.error}`}</Txt>}
    </Dialog>
  )
}

/** The failed refresh of the inbox when nothing waits: one warning line above the input. */
export function approvalsError(approvals: Approvals): string | undefined {
  return approvals.items.length === 0 ? approvals.error : undefined
}

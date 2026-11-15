import { type QuietLine, quietLineOf } from '@keith/app-model'
import type { AttentionItem } from '@keith/client'
import { GUTTER, Txt, useNow } from '@keith/ui'
import { Box } from 'ink'
import { useMemo } from 'react'

/** How the TUI opens the Inbox screen (named in the line: there is no pointer to click). */
export const INBOX_COMMAND = '/inbox'

/** The one quiet row above the input while a request waits without a card (ADR-0036 §7, tui-design 5.7). */
export function lineOf(items: readonly AttentionItem[], now: number): QuietLine | undefined {
  return quietLineOf(items, now, INBOX_COMMAND)
}

/**
 * `Keith is waiting for your yes or no · <summary> · expires in 4:32 · details /inbox`, or
 * `Confirm in the Inbox (/inbox) · <summary>`. Muted, no frame, no keys: typing is the answer.
 */
export function ConsentLine({ items }: { items: readonly AttentionItem[] }) {
  const first = useMemo(() => lineOf(items, Date.now()), [items])
  const now = useNow(first !== undefined)
  const line = lineOf(items, now)
  if (line === undefined) return null
  return (
    <Box paddingLeft={GUTTER} flexShrink={0}>
      <Txt tone="muted">
        {line.kind === 'conversation' ? `${line.text} · details ${INBOX_COMMAND}` : line.text}
      </Txt>
    </Box>
  )
}

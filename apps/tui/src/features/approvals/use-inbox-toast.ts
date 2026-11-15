import { INBOX_TOAST, newInboxIds } from '@keith/app-model'
import type { AttentionItem } from '@keith/client'
import { useToast } from '@keith/ui'
import { useEffect, useRef } from 'react'
import { INBOX_COMMAND } from './consent-line.tsx'

/** A toast `Confirm in the Inbox (/inbox)` once for each request that waits there (ADR-0036 §7). */
export function useInboxToast(items: readonly AttentionItem[]): void {
  const { push } = useToast()
  const seen = useRef(new Set<string>())
  useEffect(() => {
    if (newInboxIds(items, seen.current).length > 0)
      push(`${INBOX_TOAST} (${INBOX_COMMAND})`, { level: 'info' })
  }, [items, push])
}

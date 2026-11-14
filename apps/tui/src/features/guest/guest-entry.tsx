import { createGuestClient } from '@keith/client'
import { G, Txt } from '@keith/ui'
import { Box, useInput } from 'ink'
import { useEffect, useState } from 'react'

/** How long the status check may take before the row is simply not shown. */
const STATUS_TIMEOUT_MS = 2500

/**
 * Whether guest chat can be started at `url` right now (`GET /guest/status`, which is open). `false` while it is asked
 * and on any failure, so nothing about guest chat is shown unless the core said it is available.
 */
export function useGuestAvailable(url: string | undefined, fetchImpl?: typeof fetch): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    setAvailable(false)
    if (url === undefined) return undefined
    let live = true
    const client = createGuestClient({
      baseUrl: url,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    })
    const timer = setTimeout(() => {
      live = false
    }, STATUS_TIMEOUT_MS)
    client.status().then(
      (status) => {
        if (live) setAvailable(status.enabled && status.available)
      },
      () => undefined,
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [url, fetchImpl])
  return available
}

export interface GuestEntryProps {
  /** The guest listener of the core the sign-in panel is for (its host on the default guest port). */
  url: string
  /** The visitor chose guest chat: open it on `url`. */
  onGuest(url: string): void
  fetch?: typeof fetch
}

/**
 * The "continue as guest" row under Home's sign-in panel: drawn only when the core says guest chat is available to this
 * caller, and `ctrl+g` takes it (the identifier box owns the plain keys). Nothing is drawn, and no key is taken, otherwise.
 */
export function GuestEntry({ url, onGuest, fetch: fetchImpl }: GuestEntryProps) {
  const available = useGuestAvailable(url, fetchImpl)
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'g') onGuest(url)
    },
    { isActive: available },
  )
  if (!available) return null
  return (
    <Box marginTop={1}>
      <Txt tone="muted">{`or continue as an anonymous guest  ${G.sep}  `}</Txt>
      <Txt tone="accent">[ctrl+g]</Txt>
    </Box>
  )
}

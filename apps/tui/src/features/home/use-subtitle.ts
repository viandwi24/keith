import { useEffect, useState } from 'react'
import { plainText, SUBTITLE_HOLD_MS } from './home-state.ts'

/**
 * The subtitle of Home: the plain words of the assistant turn as they stream; once the turn ended
 * they stay for `SUBTITLE_HOLD_MS` and then clear. A new turn replaces them.
 */
export function useSubtitle(raw: string, busy: boolean, holdMs = SUBTITLE_HOLD_MS): string {
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    setExpired(false)
    if (busy || raw === '') return undefined
    const timer = setTimeout(() => setExpired(true), holdMs)
    return () => clearTimeout(timer)
  }, [raw, busy, holdMs])
  return expired ? '' : plainText(raw)
}

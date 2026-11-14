import type { KeithClient } from '@keith/client'
import { FramePanel, Txt, useFooter } from '@keith/ui'
import { useInput } from 'ink'
import { useCallback, useEffect, useState } from 'react'

export type PrivacyNoticeState =
  /** Asked, not answered yet (or the core could not say): Home is drawn as usual. */
  { status: 'checking' } | { status: 'show'; text: string } | { status: 'done' }

/** Home's privacy panel is at most this many cells wide (ADR-0019, the sign-in panel's width). */
export const PRIVACY_PANEL_MAX = 46

/**
 * Whether this person has to be told how Keith treats their things (`admin.audit.notice.get`). Any failure
 * (signed out, locked, offline, an older core) is `done`: the notice never blocks a person from the app.
 */
export function usePrivacyNotice(client: KeithClient): {
  state: PrivacyNoticeState
  ack(): void
} {
  const [state, setState] = useState<PrivacyNoticeState>({ status: 'checking' })
  useEffect(() => {
    let live = true
    client.rpc.admin.audit.notice.get().then(
      (n) => live && setState(n.seen ? { status: 'done' } : { status: 'show', text: n.text }),
      () => live && setState({ status: 'done' }),
    )
    return () => {
      live = false
    }
  }, [client])
  const ack = useCallback(() => {
    setState({ status: 'done' })
    // recorded on the core (once per person, for every device); a failure only means it shows again next time
    client.rpc.admin.audit.notice.ack().catch(() => undefined)
  }, [client])
  return { state, ack }
}

/**
 * "Your privacy": the one notice of a first sign-in, drawn as a panel over Home's lower orb (ADR-0019).
 * It owns the keys while it is on screen; `enter` gets it and acknowledges it once.
 */
export function PrivacyPanel({
  text,
  width,
  onDone,
}: {
  text: string
  width: number
  onDone(): void
}) {
  useInput((_input, key) => {
    if (key.return) onDone()
  })
  useFooter([{ key: 'enter', action: 'got it' }])
  return (
    <FramePanel
      width={Math.min(width, PRIVACY_PANEL_MAX)}
      top={[{ text: 'Your privacy' }]}
      tone="info"
      padX={1}
    >
      <Txt wrap="wrap">{text}</Txt>
    </FramePanel>
  )
}

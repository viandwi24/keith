import { FooterProvider, FramePanel, Notice, PulseGlyph, Txt, useFooter } from '@keith/ui'
import { Box, useInput } from 'ink'
import { useState } from 'react'
import { Framed } from './login-screen.tsx'

export interface LogoutScreenProps {
  /** The core being signed out of, as shown to the user. */
  core: string
  /**
   * Revoke this device's credential and forget it. Resolves with a note when the core could not be
   * reached (the credential is gone here anyway), and rejects when the credential could not be removed.
   */
  onConfirm(): Promise<{ note?: string } | undefined>
  /** Signed out: the app goes on to the Sign in screen. */
  onDone(): void
  /** `n` or `esc` before the confirmation. */
  onCancel(): void
  columns?: number
  /** Home's panel: a `FramePanel` of `width` cells over the orb (Home draws the legend), not a screen of its own. */
  panel?: { width: number }
}

type Phase =
  | { step: 'ask' }
  | { step: 'working' }
  | { step: 'note'; note: string }
  | { step: 'error'; message: string }

function Ask({ core, onYes, onCancel }: { core: string; onYes(): void; onCancel(): void }) {
  useInput((input, key) => {
    if (input === 'y') onYes()
    else if (input === 'n' || key.escape) onCancel()
  })
  useFooter([
    { key: 'y', action: 'sign out' },
    { key: 'n', action: 'cancel' },
  ])
  return (
    <Box flexDirection="column">
      <Txt wrap="wrap">{`Sign out of ${core}?`}</Txt>
      <Txt tone="muted" wrap="wrap">
        This device's credential is revoked and forgotten; you sign in again to use Keith here.
      </Txt>
    </Box>
  )
}

function Working() {
  useFooter([])
  return (
    <Box>
      <PulseGlyph />
      <Txt tone="muted"> signing out ...</Txt>
    </Box>
  )
}

function Continue({
  lines,
  level,
  onNext,
}: {
  lines: string[]
  level: 'info' | 'error'
  onNext(): void
}) {
  useInput((_input, key) => {
    if (key.return || key.escape) onNext()
  })
  useFooter([{ key: 'enter', action: 'continue' }])
  return <Notice level={level} rows={lines} />
}

/** Sign out, asked first (`/logout`): `y` confirms, `n` or `esc` cancels. Secrets never pass here. */
export function LogoutScreen({
  core,
  onConfirm,
  onDone,
  onCancel,
  columns = 100,
  panel,
}: LogoutScreenProps) {
  const [phase, setPhase] = useState<Phase>({ step: 'ask' })
  const run = (): void => {
    setPhase({ step: 'working' })
    onConfirm().then(
      (result) =>
        result?.note === undefined ? onDone() : setPhase({ step: 'note', note: result.note }),
      (error: unknown) =>
        setPhase({
          step: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
    )
  }
  const body = (() => {
    switch (phase.step) {
      case 'ask':
        return <Ask core={core} onYes={run} onCancel={onCancel} />
      case 'working':
        return <Working />
      case 'note':
        return <Continue lines={[phase.note]} level="info" onNext={onDone} />
      case 'error':
        return (
          <Continue
            lines={[`could not sign out: ${phase.message}`]}
            level="error"
            onNext={onCancel}
          />
        )
    }
  })()
  if (panel !== undefined)
    return (
      <FramePanel width={panel.width} top={[{ text: 'Sign out' }]} padX={1}>
        {body}
      </FramePanel>
    )
  return (
    <FooterProvider>
      <Framed columns={Math.max(40, columns)} label="Sign out">
        {body}
      </Framed>
    </FooterProvider>
  )
}

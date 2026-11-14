import type { KeithClient } from '@keith/client'
import type { SuccessionView } from '@keith/contracts'
import { FramePanel, Txt, useFooter, useToast } from '@keith/ui'
import { Box, useInput } from 'ink'
import { useEffect, useRef, useState } from 'react'
import { codeOf, messageOf } from '../../chat/question-state.ts'
import type { StepUp } from '../../stepup/index.ts'
import { CLAIM_WORD, claimWordOk, heirLines } from './succession-state.ts'

export interface SuccessionPanelProps {
  client: KeithClient
  /** Runs the claim through the step-up prompt (the PIN opens it, then the call goes on). */
  guard: StepUp['guard']
  /** The panel's width in cells (Home draws it over the orb, at most 46). */
  width: number
  /** The claim went through: the core revoked the sessions, so the app signs this device out (with the notice). */
  onClaimed(): void
  /** `esc`, or a claim that is not open. */
  onClose(): void
}

type Phase =
  | { step: 'loading' }
  | { step: 'view'; view: SuccessionView }
  | { step: 'none' }
  | { step: 'claiming' }

const NOT_HEIR = 'You are not the heir of this Keith.'

/**
 * `/succession` (ADR-0019: a panel over Home, never a screen). The heir sees the state; in `claimable` the typed word
 * `claim` and enter claim this Keith, with the step-up. The owner is pointed to Manage. Refusals are error toasts.
 */
export function SuccessionPanel({
  client,
  guard,
  width,
  onClaimed,
  onClose,
}: SuccessionPanelProps) {
  const { push } = useToast()
  const [phase, setPhase] = useState<Phase>({ step: 'loading' })
  const [typed, setTyped] = useState('')
  // a ref: a second Enter in the same burst must not start a second claim before the render
  const claiming = useRef(false)
  const [hint, setHint] = useState<string | undefined>()

  useEffect(() => {
    let alive = true
    client.rpc.admin.succession.get().then(
      (view) => alive && setPhase({ step: 'view', view }),
      (error: unknown) => {
        if (!alive) return
        // NOT_FOUND: neither the owner nor the heir; anything else is shown the same way
        setPhase({ step: 'none' })
        if (codeOf(error) !== 'NOT_FOUND') push(messageOf(error), { level: 'error' })
      },
    )
    return () => {
      alive = false
    }
  }, [client, push])

  const claimable =
    phase.step === 'view' && phase.view.role === 'heir' && phase.view.state === 'claimable'

  const claim = (): void => {
    if (claiming.current) return
    claiming.current = true
    setPhase({ step: 'claiming' })
    guard(() => client.rpc.admin.succession.claim({}))
      .finally(() => {
        claiming.current = false
      })
      .then(
        () => {
          // a toast line is clipped at 40 cells (TOAST_MAX_WIDTH), so the sentence is two lines; the toast provider sits
          // above the keyed app, so they outlive the swap that onClaimed makes
          push('You are the owner now.', { level: 'success' })
          push('Sign in again to continue.', { level: 'success' })
          onClaimed()
        },
        (error: unknown) => {
          push(messageOf(error), { level: 'error' })
          // the refusal changed nothing: back to the state the heir read
          setPhase({ step: 'none' })
          client.rpc.admin.succession.get().then(
            (view) => setPhase({ step: 'view', view }),
            () => setPhase({ step: 'none' }),
          )
        },
      )
  }

  useInput((input, key) => {
    if (key.escape) return onClose()
    if (!claimable) return
    if (key.return) {
      if (claimWordOk(typed)) claim()
      else setHint(`type ${CLAIM_WORD}, then enter`)
      return
    }
    if (key.backspace || key.delete) {
      setTyped((t) => t.slice(0, -1))
      setHint(undefined)
      return
    }
    if (input !== '' && !key.ctrl && !key.meta) {
      setTyped((t) => `${t}${input}`.slice(0, 16))
      setHint(undefined)
    }
  })

  useFooter(
    claimable
      ? [
          { key: 'enter', action: 'claim' },
          { key: 'esc', action: 'close' },
        ]
      : [{ key: 'esc', action: 'close' }],
  )

  const body = (() => {
    switch (phase.step) {
      case 'loading':
        return [{ text: 'reading ...', tone: 'muted' as const }]
      case 'none':
        return [{ text: NOT_HEIR, tone: 'muted' as const }]
      case 'claiming':
        return [{ text: 'claiming ...', tone: 'muted' as const }]
      case 'view':
        if (phase.view.role === 'owner')
          return [
            {
              text: 'You own this Keith. Manage > People & access > Succession.',
              tone: 'muted' as const,
            },
          ]
        return heirLines(
          phase.view.role === 'heir'
            ? phase.view
            : { role: 'heir', state: 'idle', claimableAt: null, claimOpensAt: null },
        ).map((text) => ({ text, tone: 'muted' as const }))
    }
  })()

  return (
    <FramePanel width={width} top={[{ text: 'Succession' }]} padX={1}>
      <Box flexDirection="column">
        {body.map((row) => (
          <Txt key={row.text} tone={row.tone} wrap="wrap">
            {row.text}
          </Txt>
        ))}
        {claimable && (
          <Box flexDirection="column" marginTop={1}>
            <Txt>{`type ${CLAIM_WORD}: ${typed}`}</Txt>
            {hint !== undefined && <Txt tone="muted">{hint}</Txt>}
          </Box>
        )}
      </Box>
    </FramePanel>
  )
}

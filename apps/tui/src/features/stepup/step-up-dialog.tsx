import { Dialog, dialogInner, G, KeyHints, TextInput, Txt } from '@keith/ui'
import { Box } from 'ink'
import { useState } from 'react'
import { useGuardedInput as useInput } from '../activity/index.ts'
import type { StepUp } from './use-step-up.ts'

export interface StepUpDialogProps {
  stepUp: StepUp
  width: number
}

/**
 * "Confirm it's you": a masked PIN (or password, `tab` switches) over the dialog frame. `enter`
 * confirms, `esc` cancels. A wrong secret stays open with a danger row.
 */
export function StepUpDialog({ stepUp, width }: StepUpDialogProps) {
  const { prompt } = stepUp
  const [secret, setSecret] = useState('')
  useInput(
    (_input, key) => {
      if (key.escape) return stepUp.cancel()
      if (key.tab && prompt !== undefined && !prompt.deadEnd) {
        setSecret('')
        stepUp.toggleMethod()
      }
    },
    { isActive: prompt !== undefined },
  )
  if (prompt === undefined) return null
  const label = prompt.method === 'pin' ? 'PIN' : 'password'
  const other = prompt.method === 'pin' ? 'use password' : 'use PIN'
  const footer = prompt.deadEnd ? (
    <KeyHints hints={[{ key: 'esc', action: 'close' }]} width={dialogInner(width)} />
  ) : (
    <Box flexDirection="column">
      <Box>
        <Txt tone="muted">{`${label} ${G.prompt} `}</Txt>
        <TextInput
          mask
          focus={!prompt.busy}
          value={secret}
          width={Math.max(10, width - 16)}
          placeholder={prompt.busy ? 'checking…' : `enter your ${label}`}
          onChange={setSecret}
          onSubmit={(text) => {
            stepUp.submit(text)
            setSecret('')
          }}
        />
      </Box>
      <KeyHints
        width={dialogInner(width)}
        hints={[
          { key: 'enter', action: 'confirm' },
          { key: 'tab', action: other },
          { key: 'esc', action: 'cancel' },
        ]}
      />
    </Box>
  )
  return (
    <Dialog title="Confirm it's you" focused width={width} footer={footer}>
      <Txt tone="muted">This action needs a quick check.</Txt>
      {prompt.error !== undefined && <Txt tone="danger">{`${G.failed} ${prompt.error}`}</Txt>}
    </Dialog>
  )
}

import { Field, FramePanel, Notice, Txt, useFooter } from '@keith/ui'
import { Box } from 'ink'
import { useState } from 'react'

export interface UnlockPanelProps {
  /** Cells, borders included. */
  width: number
  /**
   * Ask the core to open the socket with this PIN. Resolves with `undefined` when it opened, else the
   * line to show (the PIN is never kept: the field is cleared before the call returns).
   */
  onUnlock(pin: string): Promise<string | undefined>
}

/**
 * Home's unlock panel (tui-login.md, "The locked socket"): the local socket answered `423 locked`, so
 * the owner's PIN is the only thing to ask for. A `FramePanel` labelled `Locked` with one masked field.
 */
export function UnlockPanel({ width, onUnlock }: UnlockPanelProps) {
  const [pin, setPin] = useState('')
  const [problem, setProblem] = useState<string | undefined>()
  const [working, setWorking] = useState(false)
  useFooter([{ key: 'enter', action: 'unlock' }])
  const submit = (): void => {
    if (pin === '' || working) return
    const sent = pin
    setPin('')
    setWorking(true)
    void onUnlock(sent).then((line) => {
      setWorking(false)
      setProblem(line)
    })
  }
  return (
    <FramePanel width={width} top={[{ text: 'Locked' }]} padX={1}>
      <Box flexDirection="column">
        <Txt tone="muted" wrap="wrap">
          The local socket locked itself after a while idle. Your PIN opens it.
        </Txt>
        <Box marginTop={1}>
          <Field
            label="PIN"
            value={pin}
            focused={!working}
            width={Math.max(20, width - 4)}
            labelWidth={6}
            secret
            onChange={(v) => setPin(v.replace(/\D/g, ''))}
            onSubmit={submit}
          />
        </Box>
        {problem !== undefined && (
          <Box marginTop={1}>
            <Notice level="error" rows={[problem]} />
          </Box>
        )}
      </Box>
    </FramePanel>
  )
}

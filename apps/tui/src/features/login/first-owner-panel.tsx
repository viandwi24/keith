import { Field, FramePanel, Notice, Txt, useFooter } from '@keith/ui'
import { Box } from 'ink'
import { useState } from 'react'

export interface FirstOwnerPanelProps {
  /** Cells, borders included. */
  width: number
  /**
   * Set the owner's first PIN. Resolves with `undefined` when it was set (the app signs in), else the line
   * to show. The PIN is never kept: both fields are cleared before the call returns.
   */
  onSet(pin: string): Promise<string | undefined>
}

/**
 * Home's first-owner panel (tui-login.md, "The first owner"): this Keith has no owner sign-in at all, so
 * the socket has nobody to ask. Two masked fields (PIN, then the same again); the core allows this only
 * while the owner has neither a PIN nor a password, and never again after.
 */
export function FirstOwnerPanel({ width, onSet }: FirstOwnerPanelProps) {
  const [stage, setStage] = useState<'pin' | 'again'>('pin')
  const [first, setFirst] = useState('')
  const [typed, setTyped] = useState('')
  const [problem, setProblem] = useState<string | undefined>()
  const [working, setWorking] = useState(false)
  useFooter([{ key: 'enter', action: stage === 'pin' ? 'next' : 'set PIN' }])
  const submit = (): void => {
    if (typed === '' || working) return
    if (stage === 'pin') {
      setFirst(typed)
      setTyped('')
      setProblem(undefined)
      setStage('again')
      return
    }
    if (typed !== first) {
      setFirst('')
      setTyped('')
      setStage('pin')
      setProblem('the PINs differ: start again')
      return
    }
    const sent = typed
    setTyped('')
    setFirst('')
    setWorking(true)
    void onSet(sent).then((line) => {
      setWorking(false)
      if (line !== undefined) {
        setStage('pin')
        setProblem(line)
      }
    })
  }
  const inner = Math.max(20, width - 4)
  return (
    <FramePanel width={width} top={[{ text: 'First sign-in' }]} padX={1}>
      <Box flexDirection="column">
        <Txt tone="muted" wrap="wrap">
          Nobody can sign in to this Keith yet. Choose a PIN (6 to 12 digits): you will type it
          every time you open Keith.
        </Txt>
        <Box marginTop={1}>
          <Field
            label={stage === 'pin' ? 'PIN' : 'Again'}
            value={typed}
            focused={!working}
            width={inner}
            labelWidth={6}
            secret
            onChange={(v) => setTyped(v.replace(/\D/g, ''))}
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

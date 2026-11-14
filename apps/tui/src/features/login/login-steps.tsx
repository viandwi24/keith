import type { SignIn, SignInState } from '@keith/client'
import { G, Notice, PulseGlyph, TextInput, Txt, useFooter } from '@keith/ui'
import { Box, useInput } from 'ink'
import { useState } from 'react'
import { expiresText, spacedCode } from './login-text.ts'

type Of<S extends SignInState['step']> = Extract<SignInState, { step: S }>

interface StepProps {
  signIn: SignIn
  /** Content width (columns minus the gutter). */
  width: number
  /** The clock, ticking while a countdown is on screen. */
  now: number
}

export function AddressStep({
  signIn,
  width,
  state,
  initial,
  onCancel,
}: StepProps & { state: Of<'address'>; initial: string; onCancel(): void }) {
  const [address, setAddress] = useState(state.address === '' ? initial : state.address)
  useInput((_i, key) => {
    if (key.escape) onCancel()
  })
  useFooter([
    { key: 'enter', action: 'check' },
    { key: 'esc', action: 'cancel' },
  ])
  return (
    <Box flexDirection="column">
      <Txt tone="muted">Which core do you want to sign in to?</Txt>
      <Box marginTop={1}>
        <Txt tone="muted">{`address ${G.prompt} `}</Txt>
        <TextInput
          value={address}
          width={Math.max(10, width - 12)}
          placeholder="http://127.0.0.1:7420"
          onChange={setAddress}
          onSubmit={(text) => void signIn.submitAddress(text)}
        />
      </Box>
      {state.problem !== undefined && <Notice level="error" rows={[state.problem]} />}
    </Box>
  )
}

export function SocketStep({
  state,
  onContinue,
  onCancel,
}: {
  state: Of<'socket'>
  onContinue(): void
  onCancel(): void
}) {
  useInput((_i, key) => {
    if (key.return) onContinue()
    else if (key.escape) onCancel()
  })
  useFooter([
    { key: 'enter', action: 'continue' },
    { key: 'esc', action: 'cancel' },
  ])
  return (
    <Box flexDirection="column">
      <Txt wrap="wrap">{`${G.done} ${state.address}`}</Txt>
      <Txt tone="muted">The local socket needs no login: the socket is the login.</Txt>
    </Box>
  )
}

export function Busy({ signIn, text }: { signIn: SignIn; text: string }) {
  useInput((_i, key) => {
    if (key.escape) signIn.cancel()
  })
  useFooter([{ key: 'esc', action: 'cancel' }])
  return (
    <Box flexDirection="column">
      <Box>
        <PulseGlyph />
        <Txt tone="muted">{` ${text}`}</Txt>
      </Box>
    </Box>
  )
}

export function DeviceStep({ signIn, now, state }: StepProps & { state: Of<'device'> }) {
  useInput((_i, key) => {
    if (key.escape) signIn.cancel()
  })
  useFooter([{ key: 'esc', action: 'cancel' }])
  if (state.code === undefined)
    return <Busy signIn={signIn} text="asking the core for a code ..." />
  return (
    <Box flexDirection="column">
      <Txt>On the core machine, approve this device:</Txt>
      <Box marginTop={1} paddingLeft={2}>
        <Txt
          tone="accent"
          wrap="wrap"
        >{`keith-core devices approve ${state.code} --label <name>`}</Txt>
      </Box>
      <Box marginTop={1}>
        <Box paddingLeft={2}>
          <Txt bold>{spacedCode(state.code)}</Txt>
        </Box>
      </Box>
      <Box marginTop={1}>
        {state.polling ? <PulseGlyph /> : <Txt tone="muted">{G.idle}</Txt>}
        <Txt tone="muted">
          {` ${state.polling ? 'waiting for approval' : 'connecting'}${
            state.expiresAt === undefined ? '' : ` ${G.sep} ${expiresText(state.expiresAt, now)}`
          }`}
        </Txt>
      </Box>
    </Box>
  )
}

export function ErrorStep({ signIn, state }: StepProps & { state: Of<'error'> }) {
  useInput((_i, key) => {
    if (key.escape) signIn.back()
    else if (key.return && state.retryable) void signIn.retry()
  })
  useFooter([
    ...(state.retryable ? [{ key: 'enter', action: 'try again' }] : []),
    { key: 'esc', action: 'back' },
  ])
  return (
    <Box flexDirection="column">
      <Notice level="error" rows={[state.message]} />
    </Box>
  )
}

export function DoneStep({ state }: { state: Of<'done'> }) {
  const p = state.person
  const who = p === undefined ? '' : ` as ${p.name} (${p.role})`
  return <Txt tone="success" wrap="wrap">{`${G.done} signed in${who} on ${state.core}`}</Txt>
}
